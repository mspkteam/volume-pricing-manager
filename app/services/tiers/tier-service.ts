/**
 * Tier CRUD with validation, archiving, and optional HVAC starter preset.
 */

import type { PrismaClient } from "@prisma/client";
import {
  hvacStarterPreset,
  tierInputToPersisted,
  type TierInput,
} from "../../lib/policies";
import { validateTierInputs } from "../eligibility/tier-engine";
import { writeAuditLog } from "../audit/audit-log";
import { assertShopScope } from "../shop/shop-service";

export async function listTiers(prisma: PrismaClient, shopId: string, opts?: { includeArchived?: boolean }) {
  return prisma.pricingTier.findMany({
    where: {
      shopId,
      ...(opts?.includeArchived ? {} : { isArchived: false }),
    },
    orderBy: [{ displayOrder: "asc" }, { minSpendMinor: "asc" }],
    include: {
      _count: { select: { assignments: true } },
    },
  });
}

export async function createTier(
  prisma: PrismaClient,
  shopId: string,
  input: TierInput,
  actor: string,
) {
  validateTierInputs([input]);
  if (input.isFallback) {
    await prisma.pricingTier.updateMany({
      where: { shopId, isFallback: true },
      data: { isFallback: false },
    });
  }
  const data = tierInputToPersisted(input);
  const tier = await prisma.pricingTier.create({
    data: { shopId, ...data },
  });
  await writeAuditLog(prisma, {
    shopId,
    actor,
    action: "tier.create",
    entityType: "PricingTier",
    entityId: tier.id,
    summary: `Created tier "${tier.name}"`,
    metadata: { minSpendMinor: tier.minSpendMinor.toString(), discountBps: tier.discountBps },
  });
  return tier;
}

export async function updateTier(
  prisma: PrismaClient,
  shopId: string,
  tierId: string,
  input: Partial<TierInput> & { name?: string },
  actor: string,
) {
  const existing = await prisma.pricingTier.findUniqueOrThrow({ where: { id: tierId } });
  assertShopScope(existing.shopId, shopId, "tier");

  const merged: TierInput = {
    name: input.name ?? existing.name,
    description: input.description ?? existing.description,
    badgeColor: input.badgeColor ?? existing.badgeColor,
    minSpend:
      input.minSpend ??
      (Number(existing.minSpendMinor) / 100).toFixed(2),
    discountPercent:
      input.discountPercent ?? existing.discountBps / 100,
    requiresApproval: input.requiresApproval ?? existing.requiresApproval,
    requiresLicense: input.requiresLicense ?? existing.requiresLicense,
    requiresResaleCert: input.requiresResaleCert ?? existing.requiresResaleCert,
    requiresPurchaseAgreement:
      input.requiresPurchaseAgreement ?? existing.requiresPurchaseAgreement,
    minPurchaseHistoryMonths:
      input.minPurchaseHistoryMonths === undefined
        ? existing.minPurchaseHistoryMonths
        : input.minPurchaseHistoryMonths,
    allowProjectedVolume: input.allowProjectedVolume ?? existing.allowProjectedVolume,
    isActive: input.isActive ?? existing.isActive,
    isFallback: input.isFallback ?? existing.isFallback,
    displayOrder: input.displayOrder ?? existing.displayOrder,
  };

  const siblings = await prisma.pricingTier.findMany({
    where: { shopId, isArchived: false, id: { not: tierId } },
  });
  validateTierInputs([
    merged,
    ...siblings.map((s) => ({
      name: s.name,
      description: s.description,
      badgeColor: s.badgeColor,
      minSpend: (Number(s.minSpendMinor) / 100).toFixed(2),
      discountPercent: s.discountBps / 100,
      requiresApproval: s.requiresApproval,
      requiresLicense: s.requiresLicense,
      requiresResaleCert: s.requiresResaleCert,
      requiresPurchaseAgreement: s.requiresPurchaseAgreement,
      minPurchaseHistoryMonths: s.minPurchaseHistoryMonths,
      allowProjectedVolume: s.allowProjectedVolume,
      isActive: s.isActive,
      isFallback: s.isFallback,
      displayOrder: s.displayOrder,
    })),
  ]);

  if (merged.isFallback) {
    await prisma.pricingTier.updateMany({
      where: { shopId, isFallback: true, id: { not: tierId } },
      data: { isFallback: false },
    });
  }

  const data = tierInputToPersisted(merged);
  const tier = await prisma.pricingTier.update({
    where: { id: tierId },
    data: { ...data, configVersion: { increment: 1 } },
  });

  await writeAuditLog(prisma, {
    shopId,
    actor,
    action: "tier.update",
    entityType: "PricingTier",
    entityId: tier.id,
    summary: `Updated tier "${tier.name}" (id preserved)`,
    reason: existing.name !== tier.name ? `Renamed from "${existing.name}"` : null,
  });
  return tier;
}

export async function getArchiveImpact(prisma: PrismaClient, shopId: string, tierId: string) {
  const tier = await prisma.pricingTier.findUniqueOrThrow({ where: { id: tierId } });
  assertShopScope(tier.shopId, shopId, "tier");
  const assignedCount = await prisma.customerProfiles.count({
    where: { shopId, effectiveTierId: tierId },
  });
  return { tier, assignedCount };
}

export async function archiveTier(
  prisma: PrismaClient,
  shopId: string,
  tierId: string,
  actor: string,
  strategy: { reassignToTierId?: string | null; useFallback: boolean },
) {
  const { tier, assignedCount } = await getArchiveImpact(prisma, shopId, tierId);
  if (assignedCount > 0 && !strategy.useFallback && !strategy.reassignToTierId) {
    throw new Error(
      `${assignedCount} customers are assigned to this tier. Choose a reassignment target or fallback strategy before archiving.`,
    );
  }

  let targetId: string | null = strategy.reassignToTierId ?? null;
  if (strategy.useFallback) {
    const fallback = await prisma.pricingTier.findFirst({
      where: { shopId, isFallback: true, isArchived: false, id: { not: tierId } },
    });
    if (!fallback) throw new Error("No fallback tier configured for reassignment");
    targetId = fallback.id;
  }

  await prisma.$transaction(async (tx) => {
    if (targetId && assignedCount > 0) {
      await tx.customerProfiles.updateMany({
        where: { shopId, effectiveTierId: tierId },
        data: { effectiveTierId: targetId, calculatedTierId: targetId },
      });
    }
    await tx.pricingTier.update({
      where: { id: tierId },
      data: { isArchived: true, isActive: false, isFallback: false },
    });
  });

  await writeAuditLog(prisma, {
    shopId,
    actor,
    action: "tier.archive",
    entityType: "PricingTier",
    entityId: tierId,
    summary: `Archived tier "${tier.name}" (${assignedCount} customers reassigned)`,
    metadata: { reassignToTierId: targetId, assignedCount },
  });
}

export async function applyStarterPreset(prisma: PrismaClient, shopId: string, actor: string) {
  const existing = await prisma.pricingTier.count({ where: { shopId, isArchived: false } });
  if (existing > 0) {
    throw new Error("Starter preset can only be applied when no active tiers exist");
  }
  const created = [];
  for (const input of hvacStarterPreset()) {
    created.push(await createTier(prisma, shopId, input, actor));
  }
  await writeAuditLog(prisma, {
    shopId,
    actor,
    action: "tier.preset",
    entityType: "PricingTier",
    summary: "Applied optional HVAC starter preset (editable)",
  });
  return created;
}

export async function reorderTiers(
  prisma: PrismaClient,
  shopId: string,
  orderedIds: string[],
  actor: string,
) {
  await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.pricingTier.updateMany({
        where: { id, shopId },
        data: { displayOrder: index },
      }),
    ),
  );
  await writeAuditLog(prisma, {
    shopId,
    actor,
    action: "tier.reorder",
    entityType: "PricingTier",
    summary: "Updated tier display order (qualification unchanged)",
  });
}
