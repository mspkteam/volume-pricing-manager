import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop, parseSpendPolicy } from "../services/shop/shop-service";
import { formatMoney, bpsToPercentString } from "../lib/money";
import { buildExplainer } from "../services/explainer/build-explainer";
import { formatDateTime, formatChangeType } from "../lib/format";
import {
  ChecklistPanel,
  EmptyState,
  PageIntro,
  PricingStatusBadge,
  StatCard,
  StatGrid,
  TierName,
} from "../components/admin/ui";

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
      badgeColor: t.badgeColor,
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
      at: c.createdAt.toISOString(),
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
        Manage tiers
      </s-button>
      <s-button slot="secondary-actions" href="/app/how-it-works">
        How it works
      </s-button>

      <PageIntro>
        Rolling spend drives tier assignment in {data.shop.currencyCode}. Checkout discounts stay
        gated until pricing setup is verified — automation can run independently.
      </PageIntro>

      {data.shop.pricingStatus === "NOT_CONFIGURED" ||
      data.shop.pricingCompatibility === "SETUP_REQUIRED" ||
      data.shop.pricingCompatibility === "UNKNOWN" ? (
        <s-banner tone="warning" heading="Checkout pricing: Setup required">
          Tier automation can run without live checkout discounts. Verify Shopify Functions
          compatibility (custom apps need Plus) before enabling pricing writes. See Settings.
        </s-banner>
      ) : null}

      {data.shop.historyAccessLimited ? (
        <s-banner tone="warning" heading="Insufficient history">
          Imported order history may not cover the full rolling window. Automatic downgrades from
          incomplete data are blocked by default.
        </s-banner>
      ) : null}

      <StatGrid>
        <StatCard label="Customer profiles" value={data.customerCount} />
        <StatCard
          label="Pending approvals"
          value={data.pendingApprovals}
          hint={data.pendingApprovals > 0 ? "Review in Customers" : undefined}
        />
        <StatCard label="Active tiers" value={data.tiers.filter((t) => t.isActive).length} />
        <StatCard
          label="Failed jobs"
          value={data.failedJobs}
          hint={data.failedJobs > 0 ? "See Activity" : "All clear"}
        />
      </StatGrid>

      <s-section heading="Setup checklist">
        <ChecklistPanel items={data.checklist} />
        <div className="vpm-meta-row">
          <s-stack direction="inline" gap="base">
            <s-button href="/app/tiers">Configure tiers</s-button>
            <s-button href="/app/forms" variant="secondary">
              Forms
            </s-button>
            <s-button href="/app/wholesale" variant="tertiary">
              Wholesale
            </s-button>
          </s-stack>
        </div>
      </s-section>

      <s-section heading="Tools">
        <s-stack direction="inline" gap="base">
          <s-button href="/app/simulator" variant="secondary">
            Simulator
          </s-button>
          <s-button href="/app/activity" variant="secondary">
            Activity log
          </s-button>
          <s-button href="/app/applications" variant="secondary">
            Applications inbox
          </s-button>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="At a glance">
        <div className="vpm-panel vpm-stack-tight">
          <s-paragraph>
            <s-text type="strong">Pricing</s-text>
          </s-paragraph>
          <PricingStatusBadge
            status={data.shop.pricingStatus}
            compatibility={data.shop.pricingCompatibility}
          />
          <hr className="vpm-divider" />
          <s-paragraph>
            Automation:{" "}
            <s-badge tone={data.shop.automationPaused ? "warning" : "success"}>
              {data.shop.automationPaused ? "Paused" : "Running"}
            </s-badge>
          </s-paragraph>
          <s-paragraph>
            Import: <s-text type="strong">{data.shop.importStatus}</s-text>
          </s-paragraph>
          {data.shop.historyCoverageMonths != null ? (
            <s-paragraph>History: {data.shop.historyCoverageMonths} months loaded</s-paragraph>
          ) : null}
        </div>
      </s-section>

      <s-section heading="Customers by tier">
        {data.tiers.length === 0 ? (
          <EmptyState
            title="No pricing tiers yet"
            body="Create custom tiers or apply the optional HVAC starter preset to begin assigning customers."
          >
            <s-button href="/app/tiers">Go to tiers</s-button>
          </EmptyState>
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
                    <TierName
                      name={t.name}
                      badgeColor={t.badgeColor}
                      fallback={t.isFallback}
                    />
                    {!t.isActive ? (
                      <span className="vpm-tag" style={{ marginLeft: "0.5rem" }}>
                        Inactive
                      </span>
                    ) : null}
                  </s-table-cell>
                  <s-table-cell>{t.minSpend}</s-table-cell>
                  <s-table-cell>{t.discount}%</s-table-cell>
                  <s-table-cell>{t.assigned}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Sync & automation health">
        <div className="vpm-panel vpm-panel--subdued">
          <div className="vpm-meta-row">
            <span>
              Last sync: <strong>{formatDateTime(data.shop.lastSuccessfulSyncAt)}</strong>
            </span>
            <span>
              Last recalculation:{" "}
              <strong>{formatDateTime(data.shop.lastRecalculationAt)}</strong>
            </span>
            <span>
              Next run: <strong>{formatDateTime(data.shop.nextScheduledRunAt)}</strong>
            </span>
            <span>
              Timezone: <strong>{data.shop.timezone}</strong>
            </span>
          </div>
        </div>
      </s-section>

      <s-section heading="Recent assignment changes">
        {data.recentChanges.length === 0 ? (
          <EmptyState
            title="No changes yet"
            body="When customers move between tiers, the reason and timestamp appear here."
          />
        ) : (
          <div className="vpm-panel">
            {data.recentChanges.map((c) => (
              <div key={c.id} className="vpm-change-row">
                <s-text type="strong">
                  {c.from} → {c.to}
                </s-text>
                <div className="vpm-change-meta">
                  {formatChangeType(c.changeType)} · {c.reason} · {formatDateTime(c.at)}
                </div>
              </div>
            ))}
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
