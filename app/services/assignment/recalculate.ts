/**
 * Recalculate a customer's qualifying spend and tier assignment.
 */

import type { PrismaClient } from "@prisma/client";
import { calculateQualifyingSpend } from "../spend/calculate-spend";
import { decideAssignment } from "../assignment/decide-assignment";
import {
  parseAutomationPolicy,
  parseSpendPolicy,
} from "../shop/shop-service";
import { writeAuditLog } from "../audit/audit-log";
import { enqueueJob, JOB_TYPES } from "../jobs/queue";
import type { TierRecord } from "../eligibility/tier-engine";

export async function recalculateCustomer(
  prisma: PrismaClient,
  args: {
    shopId: string;
    shopDomain: string;
    customerProfileId: string;
    actor?: string;
    enqueuePricingSync?: boolean;
  },
) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: args.shopId } });
  const customer = await prisma.customerProfiles.findFirst({
    where: { id: args.customerProfileId, shopId: args.shopId },
  });
  if (!customer) throw new Error("Customer not found in this shop");

  const spendPolicy = parseSpendPolicy(shop.spendPolicy);
  const automationPolicy = parseAutomationPolicy(shop.automationPolicy);
  if (shop.automationPaused) {
    automationPolicy.pauseAutomation = true;
  }

  const orders = await prisma.normalizedOrders.findMany({
    where: { shopId: args.shopId, shopifyCustomerId: customer.shopifyCustomerId },
    include: { lines: true },
  });

  const now = new Date();
  const breakdown = calculateQualifyingSpend(
    orders.map((o) => ({
      processedAt: o.processedAt,
      financialStatus: o.financialStatus,
      cancelledAt: o.cancelledAt,
      test: o.test,
      currencyCode: o.currencyCode,
      merchandiseMinor: o.merchandiseMinor,
      refundedMerchandiseMinor: o.refundedMerchandiseMinor,
      qualifyingMinor: o.qualifyingMinor,
      salesChannel: o.salesChannel,
      sourceName: o.sourceName,
      lines: o.lines.map((l) => ({
        merchandiseMinor: l.merchandiseMinor,
        isGiftCard: l.isGiftCard,
        excluded: l.excluded,
        productId: l.productId,
        collectionIds: l.collectionIds,
      })),
    })),
    spendPolicy,
    shop.currencyCode,
    now,
    shop.timezone,
  );

  const tiers = (await prisma.pricingTier.findMany({
    where: { shopId: args.shopId, isArchived: false },
  })) as unknown as TierRecord[];

  const decision = decideAssignment({
    spendMinor: breakdown.qualifyingSpendMinor,
    tiers,
    flags: {
      businessApproved: customer.businessApproved,
      licenseVerified: customer.licenseVerified,
      resaleCertVerified: customer.resaleCertVerified,
      purchaseAgreementVerified: customer.purchaseAgreementVerified,
      projectedVolumeApproved: customer.projectedVolumeApproved,
      firstOrderAt: customer.firstOrderAt,
      now,
    },
    current: {
      calculatedTierId: customer.calculatedTierId,
      effectiveTierId: customer.effectiveTierId,
      pendingTierId: customer.pendingTierId,
      overrideTierId: customer.overrideTierId,
      overrideExpiresAt: customer.overrideExpiresAt,
      overridePausesAutomation: customer.overridePausesAutomation,
      gracePeriodEndsAt: customer.gracePeriodEndsAt,
      nextReviewAt: customer.nextReviewAt,
      historyStatus: customer.historyStatus,
      protectFromIncompleteHistoryDowngrade: spendPolicy.protectFromIncompleteHistoryDowngrade,
    },
    policy: automationPolicy,
    now,
  });

  const previousEffective = customer.effectiveTierId;
  const assignmentVersion =
    decision.changeType && decision.effectiveTierId !== previousEffective
      ? customer.assignmentVersion + 1
      : customer.assignmentVersion;

  const updated = await prisma.customerProfiles.update({
    where: { id: customer.id },
    data: {
      qualifyingSpendMinor: breakdown.qualifyingSpendMinor,
      includedOrderCount: breakdown.includedOrderCount,
      refundDeductionMinor: breakdown.refundDeductionMinor,
      windowStart: breakdown.window.start,
      windowEnd: breakdown.window.end,
      lastCalculatedAt: now,
      calculatedTierId: decision.calculatedTierId,
      effectiveTierId: decision.effectiveTierId,
      pendingTierId: decision.pendingTierId,
      gracePeriodEndsAt: decision.gracePeriodEndsAt,
      nextReviewAt: decision.nextReviewAt,
      assignmentVersion,
      lastAssignedAt: decision.changeType ? now : customer.lastAssignedAt,
      // Clear expired override
      ...(customer.overrideExpiresAt && customer.overrideExpiresAt <= now
        ? {
            overrideTierId: null,
            overrideReason: null,
            overrideExpiresAt: null,
            overridePausesAutomation: false,
          }
        : {}),
    },
  });

  if (decision.changeType && decision.effectiveTierId !== previousEffective) {
    await prisma.tierAssignmentHistory.create({
      data: {
        shopId: args.shopId,
        customerProfileId: customer.id,
        fromTierId: previousEffective,
        toTierId: decision.effectiveTierId,
        calculatedTierId: decision.calculatedTierId,
        effectiveTierId: decision.effectiveTierId,
        changeType: decision.changeType,
        reason: decision.reason,
        actor: args.actor ?? "system",
        spendSnapshotMinor: breakdown.qualifyingSpendMinor,
      },
    });
    await writeAuditLog(prisma, {
      shopId: args.shopId,
      actor: args.actor ?? "system",
      action: "assignment.change",
      entityType: "CustomerProfile",
      entityId: customer.id,
      reason: decision.reason,
      summary: `Tier assignment changed (${decision.changeType})`,
    });
  }

  if (
    args.enqueuePricingSync !== false &&
    decision.effectiveTierId !== previousEffective
  ) {
    const tier = tiers.find((t) => t.id === decision.effectiveTierId);
    await enqueueJob(prisma, {
      shopDomain: args.shopDomain,
      shopId: args.shopId,
      type: JOB_TYPES.SYNC_PRICING_CUSTOMER,
      payload: {
        customerProfileId: customer.id,
        tierId: decision.effectiveTierId,
        discountBps: tier?.discountBps ?? 0,
        tierName: tier?.name ?? null,
        assignmentVersion,
        configVersion: shop.settingsVersion,
      },
      idempotencyKey: `sync-pricing:${customer.id}:${assignmentVersion}`,
    });
  }

  // Clay-like storefront access: always refresh tags after assignment/eligibility calc
  if (args.enqueuePricingSync !== false) {
    await enqueueJob(prisma, {
      shopDomain: args.shopDomain,
      shopId: args.shopId,
      type: JOB_TYPES.SYNC_WHOLESALE_ACCESS,
      payload: { customerProfileId: customer.id },
      idempotencyKey: `sync-access:${customer.id}:${assignmentVersion}:${customer.businessApproved}:${decision.effectiveTierId ?? "none"}`,
    });
  }

  return { customer: updated, breakdown, decision };
}

export async function recalculateShopCustomers(
  prisma: PrismaClient,
  shopId: string,
  shopDomain: string,
) {
  const customers = await prisma.customerProfiles.findMany({
    where: { shopId },
    select: { id: true },
  });
  let processed = 0;
  for (const c of customers) {
    await recalculateCustomer(prisma, {
      shopId,
      shopDomain,
      customerProfileId: c.id,
      actor: "scheduler",
    });
    processed += 1;
  }
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      lastRecalculationAt: new Date(),
      nextScheduledRunAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  return { processed };
}
