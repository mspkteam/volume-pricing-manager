import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import { recalculateCustomer } from "../services/assignment/recalculate";
import { enqueueJob, JOB_TYPES } from "../services/jobs/queue";
import { writeAuditLog } from "../services/audit/audit-log";
import { formatMoney, bpsToPercentString } from "../lib/money";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const customer = await prisma.customerProfiles.findFirst({
    where: { id: params.id, shopId: shop.id },
    include: {
      effectiveTier: true,
      calculatedTier: true,
      pendingTier: true,
      overrideTier: true,
      assignmentHistory: { orderBy: { createdAt: "desc" }, take: 20, include: { fromTier: true, toTier: true } },
    },
  });
  if (!customer) throw new Response("Not found", { status: 404 });
  const tiers = await prisma.pricingTier.findMany({
    where: { shopId: shop.id, isArchived: false },
    orderBy: { minSpendMinor: "asc" },
  });

  return {
    currencyCode: shop.currencyCode,
    shopPricingStatus: shop.pricingStatus,
    customer: {
      id: customer.id,
      shopifyCustomerId: customer.shopifyCustomerId,
      name: customer.displayName || customer.email || customer.shopifyCustomerId,
      email: customer.email,
      spend: formatMoney(customer.qualifyingSpendMinor, shop.currencyCode),
      refunds: formatMoney(customer.refundDeductionMinor, shop.currencyCode),
      orderCount: customer.includedOrderCount,
      windowStart: customer.windowStart?.toISOString() ?? null,
      windowEnd: customer.windowEnd?.toISOString() ?? null,
      calculatedTier: customer.calculatedTier?.name ?? "—",
      effectiveTier: customer.effectiveTier?.name ?? "—",
      pendingTier: customer.pendingTier?.name ?? "—",
      effectiveDiscount: customer.effectiveTier
        ? `${bpsToPercentString(customer.effectiveTier.discountBps)}%`
        : "—",
      businessApproved: customer.businessApproved,
      licenseVerified: customer.licenseVerified,
      resaleCertVerified: customer.resaleCertVerified,
      purchaseAgreementVerified: customer.purchaseAgreementVerified,
      projectedVolumeApproved: customer.projectedVolumeApproved,
      adminNotes: customer.adminNotes,
      overrideTier: customer.overrideTier?.name ?? null,
      overrideReason: customer.overrideReason,
      overrideExpiresAt: customer.overrideExpiresAt,
      overridePausesAutomation: customer.overridePausesAutomation,
      gracePeriodEndsAt: customer.gracePeriodEndsAt,
      nextReviewAt: customer.nextReviewAt,
      pricingSyncStatus: customer.pricingSyncStatus,
      pricingLastError: customer.pricingLastError,
      historyStatus: customer.historyStatus,
      spendComplete: customer.spendComplete,
    },
    history: customer.assignmentHistory.map((h) => ({
      id: h.id,
      at: h.createdAt.toISOString(),
      type: h.changeType,
      from: h.fromTier?.name ?? "—",
      to: h.toTier?.name ?? "—",
      reason: h.reason,
      actor: h.actor,
    })),
    tiers: tiers.map((t) => ({ id: t.id, name: t.name })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const id = params.id!;

  try {
    if (intent === "recalculate") {
      await recalculateCustomer(prisma, {
        shopId: shop.id,
        shopDomain: session.shop,
        customerProfileId: id,
        actor: session.shop,
      });
      return { ok: true, message: "Recalculated spend and assignment." };
    }
    if (intent === "retry_sync") {
      const customer = await prisma.customerProfiles.findFirstOrThrow({
        where: { id, shopId: shop.id },
        include: { effectiveTier: true },
      });
      await enqueueJob(prisma, {
        shopDomain: session.shop,
        shopId: shop.id,
        type: JOB_TYPES.SYNC_PRICING_CUSTOMER,
        payload: {
          customerProfileId: customer.id,
          tierId: customer.effectiveTierId,
          discountBps: customer.effectiveTier?.discountBps ?? 0,
          assignmentVersion: customer.assignmentVersion,
          configVersion: shop.settingsVersion,
        },
        idempotencyKey: `sync-retry:${customer.id}:${Date.now()}`,
      });
      return { ok: true, message: "Pricing sync job enqueued." };
    }
    if (intent === "eligibility") {
      await prisma.customerProfiles.update({
        where: { id },
        data: {
          businessApproved: form.get("businessApproved") === "on",
          licenseVerified: form.get("licenseVerified") === "on",
          resaleCertVerified: form.get("resaleCertVerified") === "on",
          purchaseAgreementVerified: form.get("purchaseAgreementVerified") === "on",
          projectedVolumeApproved: form.get("projectedVolumeApproved") === "on",
          adminNotes: String(form.get("adminNotes") || ""),
        },
      });
      await writeAuditLog(prisma, {
        shopId: shop.id,
        actor: session.shop,
        action: "customer.eligibility",
        entityType: "CustomerProfile",
        entityId: id,
        summary: "Updated eligibility flags",
      });
      await recalculateCustomer(prisma, {
        shopId: shop.id,
        shopDomain: session.shop,
        customerProfileId: id,
        actor: session.shop,
      });
      return { ok: true, message: "Eligibility updated and recalculated." };
    }
    if (intent === "override") {
      const tierId = String(form.get("overrideTierId") || "") || null;
      const expires = String(form.get("overrideExpiresAt") || "");
      await prisma.customerProfiles.update({
        where: { id },
        data: {
          overrideTierId: tierId,
          overrideReason: String(form.get("overrideReason") || ""),
          overrideExpiresAt: expires ? new Date(expires) : null,
          overridePausesAutomation: form.get("overridePausesAutomation") === "on",
          overrideSetAt: new Date(),
          overrideSetBy: session.shop,
          effectiveTierId: tierId,
        },
      });
      await writeAuditLog(prisma, {
        shopId: shop.id,
        actor: session.shop,
        action: "customer.override",
        entityType: "CustomerProfile",
        entityId: id,
        reason: String(form.get("overrideReason") || ""),
        summary: "Manual override set",
      });
      return { ok: true, message: "Override saved." };
    }
    if (intent === "clear_override") {
      await prisma.customerProfiles.update({
        where: { id },
        data: {
          overrideTierId: null,
          overrideReason: null,
          overrideExpiresAt: null,
          overridePausesAutomation: false,
        },
      });
      await recalculateCustomer(prisma, {
        shopId: shop.id,
        shopDomain: session.shop,
        customerProfileId: id,
        actor: session.shop,
      });
      return { ok: true, message: "Override cleared; recalculated." };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Action failed" };
  }
  return { ok: false, message: "Unknown action" };
};

export default function CustomerDetailPage() {
  const { customer, history, tiers, shopPricingStatus } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading={customer.name}>
      <s-link slot="breadcrumb-actions" href="/app/customers">
        Customers
      </s-link>
      {actionData?.message ? (
        <s-banner tone={actionData.ok ? "success" : "critical"}>{actionData.message}</s-banner>
      ) : null}

      <s-section heading="Spend & tiers">
        <s-paragraph>
          Window: {customer.windowStart ?? "—"} → {customer.windowEnd ?? "—"}
        </s-paragraph>
        <s-paragraph>
          Qualifying spend: {customer.spend} · Orders: {customer.orderCount} · Refund deductions:{" "}
          {customer.refunds}
        </s-paragraph>
        <s-paragraph>
          Calculated: {customer.calculatedTier} · Effective: {customer.effectiveTier} (
          {customer.effectiveDiscount}) · Pending: {customer.pendingTier}
        </s-paragraph>
        <s-paragraph>
          History: {customer.historyStatus}
          {!customer.spendComplete ? " · Spend data may be incomplete" : ""}
        </s-paragraph>
        <s-paragraph>
          Pricing sync: <s-badge>{customer.pricingSyncStatus}</s-badge> (shop provider:{" "}
          {shopPricingStatus})
          {customer.pricingLastError ? ` — ${customer.pricingLastError}` : ""}
        </s-paragraph>
        <s-stack direction="inline" gap="base">
          <Form method="post">
            <input type="hidden" name="intent" value="recalculate" />
            <s-button type="submit">Recalculate</s-button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="retry_sync" />
            <s-button type="submit" variant="secondary">
              Retry pricing sync
            </s-button>
          </Form>
        </s-stack>
      </s-section>

      <s-section heading="Eligibility">
        <Form method="post">
          <input type="hidden" name="intent" value="eligibility" />
          <s-stack direction="block" gap="base">
            <label>
              <input type="checkbox" name="businessApproved" defaultChecked={customer.businessApproved} />{" "}
              Business approved
            </label>
            <label>
              <input type="checkbox" name="licenseVerified" defaultChecked={customer.licenseVerified} />{" "}
              License / contractor ID verified
            </label>
            <label>
              <input
                type="checkbox"
                name="resaleCertVerified"
                defaultChecked={customer.resaleCertVerified}
              />{" "}
              Resale certificate verified
            </label>
            <label>
              <input
                type="checkbox"
                name="purchaseAgreementVerified"
                defaultChecked={customer.purchaseAgreementVerified}
              />{" "}
              Purchase agreement verified
            </label>
            <label>
              <input
                type="checkbox"
                name="projectedVolumeApproved"
                defaultChecked={customer.projectedVolumeApproved}
              />{" "}
              Projected-volume approved
            </label>
            <s-text-field name="adminNotes" label="Admin notes" value={customer.adminNotes} />
            <s-button type="submit">Save eligibility</s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Manual override">
        <s-paragraph>
          Current override: {customer.overrideTier ?? "None"}
          {customer.overrideReason ? ` — ${customer.overrideReason}` : ""}
        </s-paragraph>
        <Form method="post">
          <input type="hidden" name="intent" value="override" />
          <s-stack direction="block" gap="base">
            <select name="overrideTierId" defaultValue="">
              <option value="">Select tier</option>
              {tiers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <s-text-field name="overrideReason" label="Reason (required)" required />
            <s-text-field name="overrideExpiresAt" label="Expiry (ISO date, optional)" />
            <label>
              <input type="checkbox" name="overridePausesAutomation" /> Pause automated reassignment
            </label>
            <s-button type="submit">Set override</s-button>
          </s-stack>
        </Form>
        {customer.overrideTier ? (
          <Form method="post">
            <input type="hidden" name="intent" value="clear_override" />
            <s-button type="submit" variant="tertiary">
              Clear override
            </s-button>
          </Form>
        ) : null}
      </s-section>

      <s-section heading="Assignment history">
        {history.length === 0 ? (
          <s-paragraph>No history yet.</s-paragraph>
        ) : (
          <s-unordered-list>
            {history.map((h) => (
              <s-list-item key={h.id}>
                {String(h.at)} · {h.type}: {h.from} → {h.to} — {h.reason} ({h.actor})
              </s-list-item>
            ))}
          </s-unordered-list>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
