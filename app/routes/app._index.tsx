import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop, parseSpendPolicy } from "../services/shop/shop-service";
import { formatMoney, bpsToPercentString } from "../lib/money";
import { buildExplainer } from "../services/explainer/build-explainer";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  let currencyCode = "USD";
  let timezone = "America/New_York";
  try {
    const res = await admin.graphql(`#graphql
      query ShopInfo { shop { currencyCode ianaTimezone name } }`);
    const json = await res.json();
    currencyCode = json.data?.shop?.currencyCode ?? currencyCode;
    timezone = json.data?.shop?.ianaTimezone ?? timezone;
  } catch {
    // Dev without API — use defaults
  }

  const shop = await ensureShop(prisma, session.shop, {
    currencyCode,
    timezone,
    displayName: process.env.APP_DISPLAY_NAME || "Volume Pricing Manager",
  });

  const tiers = await prisma.pricingTier.findMany({
    where: { shopId: shop.id, isArchived: false },
    include: { _count: { select: { assignments: true } } },
    orderBy: { displayOrder: "asc" },
  });

  const customerCount = await prisma.customerProfiles.count({ where: { shopId: shop.id } });
  const pendingApprovals = await prisma.customerProfiles.count({
    where: { shopId: shop.id, businessApproved: false, pendingTierId: { not: null } },
  });
  const recentChanges = await prisma.tierAssignmentHistory.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 8,
    include: { toTier: true, fromTier: true },
  });
  const failedJobs = await prisma.backgroundJobs.count({
    where: { shopDomain: session.shop, status: { in: ["FAILED", "DEAD"] } },
  });

  const spendPolicy = parseSpendPolicy(shop.spendPolicy);
  const explainer = buildExplainer({
    displayName: shop.displayName,
    currencyCode: shop.currencyCode,
    timezone: shop.timezone,
    spendPolicy,
    automationPolicy: shop.automationPolicy as never,
    tiers,
    pricingStatus: shop.pricingStatus,
    pricingProviderLabel: "Shopify Discount Function",
    historyAccessLimited: shop.historyAccessLimited,
  });

  return {
    shop: {
      displayName: shop.displayName,
      currencyCode: shop.currencyCode,
      timezone: shop.timezone,
      pricingStatus: shop.pricingStatus,
      pricingCompatibility: shop.pricingCompatibility,
      importStatus: shop.importStatus,
      lastSuccessfulSyncAt: shop.lastSuccessfulSyncAt?.toISOString() ?? null,
      lastRecalculationAt: shop.lastRecalculationAt?.toISOString() ?? null,
      nextScheduledRunAt: shop.nextScheduledRunAt?.toISOString() ?? null,
      automationPaused: shop.automationPaused,
      historyAccessLimited: shop.historyAccessLimited,
      historyCoverageMonths: shop.historyCoverageMonths,
    },
    tiers: tiers.map((t) => ({
      id: t.id,
      name: t.name,
      discount: bpsToPercentString(t.discountBps),
      minSpend: formatMoney(t.minSpendMinor, shop.currencyCode),
      assigned: t._count.assignments,
      isActive: t.isActive,
      isFallback: t.isFallback,
    })),
    customerCount,
    pendingApprovals,
    recentChanges: recentChanges.map((c) => ({
      id: c.id,
      reason: c.reason,
      changeType: c.changeType,
      at: c.createdAt,
      from: c.fromTier?.name ?? "—",
      to: c.toTier?.name ?? "—",
    })),
    failedJobs,
    checklist: explainer.checklist,
  };
};

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading={data.shop.displayName}>
      <s-button slot="primary-action" href="/app/tiers">
        Create tiers
      </s-button>
      <s-button slot="secondary-actions" href="/app/how-it-works">
        How it works
      </s-button>

      {data.shop.pricingStatus === "NOT_CONFIGURED" ||
      data.shop.pricingCompatibility === "SETUP_REQUIRED" ||
      data.shop.pricingCompatibility === "UNKNOWN" ? (
        <s-banner tone="warning" heading="Checkout pricing: Setup required">
          Tier automation can run without live checkout discounts. Verify Shopify
          Functions compatibility (custom apps need Plus) before enabling pricing
          writes. See Settings and ARCHITECTURE.md.
        </s-banner>
      ) : null}

      {data.shop.historyAccessLimited ? (
        <s-banner tone="warning" heading="Insufficient history">
          Imported order history may not cover the full rolling window. Automatic
          downgrades from incomplete data are blocked by default.
        </s-banner>
      ) : null}

      <s-section heading="Setup checklist">
        <s-unordered-list>
          {data.checklist.map((item) => (
            <s-list-item key={item.id}>
              {item.done ? "✓" : "○"} {item.label}
            </s-list-item>
          ))}
        </s-unordered-list>
        <s-stack direction="inline" gap="base">
          <s-button href="/app/tiers">Configure tiers</s-button>
          <s-button href="/app/customers" variant="secondary">
            Import / review customers
          </s-button>
          <s-button href="/app/how-it-works" variant="tertiary">
            Open explainer
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Customers by tier">
        {data.tiers.length === 0 ? (
          <s-paragraph>
            No tiers yet. Create custom tiers or apply the optional starter preset.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Tier</s-table-header>
              <s-table-header>Min spend</s-table-header>
              <s-table-header>Discount</s-table-header>
              <s-table-header>Customers</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.tiers.map((t) => (
                <s-table-row key={t.id}>
                  <s-table-cell>
                    {t.name}
                    {t.isFallback ? " (fallback)" : ""}
                  </s-table-cell>
                  <s-table-cell>{t.minSpend}</s-table-cell>
                  <s-table-cell>{t.discount}%</s-table-cell>
                  <s-table-cell>{t.assigned}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        <s-paragraph>
          Total customer profiles: {data.customerCount}. Pending approvals:{" "}
          {data.pendingApprovals}.
        </s-paragraph>
      </s-section>

      <s-section heading="Sync & automation health">
        <s-paragraph>
          Pricing status: <s-badge>{data.shop.pricingStatus}</s-badge> · Automation:{" "}
          {data.shop.automationPaused ? "Paused" : "Running"} · Failed jobs:{" "}
          {data.failedJobs}
        </s-paragraph>
        <s-paragraph>
          Last sync: {data.shop.lastSuccessfulSyncAt ?? "Never"} · Last
          recalculation: {data.shop.lastRecalculationAt ?? "Never"} · Next run:{" "}
          {data.shop.nextScheduledRunAt ?? "Not scheduled"}
        </s-paragraph>
        <s-paragraph>
          Import status: {data.shop.importStatus}
          {data.shop.historyCoverageMonths != null
            ? ` · History coverage: ${data.shop.historyCoverageMonths} months`
            : ""}
        </s-paragraph>
      </s-section>

      <s-section heading="Recent assignment changes">
        {data.recentChanges.length === 0 ? (
          <s-paragraph>No assignment changes recorded yet.</s-paragraph>
        ) : (
          <s-unordered-list>
            {data.recentChanges.map((c) => (
              <s-list-item key={c.id}>
                {c.from} → {c.to} ({c.changeType}): {c.reason}
              </s-list-item>
            ))}
          </s-unordered-list>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
