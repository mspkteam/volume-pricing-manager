import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import { formatMoney, bpsToPercentString } from "../lib/money";
import { EmptyState, PageIntro } from "../components/admin/ui";
import { pricingStatusLabel } from "../lib/pricing-status";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const tierId = url.searchParams.get("tier") ?? "";
  const approval = url.searchParams.get("approval") ?? "";
  const override = url.searchParams.get("override") ?? "";
  const sync = url.searchParams.get("sync") ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const take = 25;
  const skip = (page - 1) * take;

  const where = {
    shopId: shop.id,
    ...(q
      ? {
          OR: [
            { email: { contains: q, mode: "insensitive" as const } },
            { displayName: { contains: q, mode: "insensitive" as const } },
            { shopifyCustomerId: { contains: q } },
          ],
        }
      : {}),
    ...(tierId ? { effectiveTierId: tierId } : {}),
    ...(approval === "pending" ? { businessApproved: false } : {}),
    ...(approval === "approved" ? { businessApproved: true } : {}),
    ...(override === "yes" ? { overrideTierId: { not: null } } : {}),
    ...(sync ? { pricingSyncStatus: sync as never } : {}),
  };

  const [total, customers, tiers] = await Promise.all([
    prisma.customerProfiles.count({ where }),
    prisma.customerProfiles.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip,
      take,
      include: { effectiveTier: true },
    }),
    prisma.pricingTier.findMany({
      where: { shopId: shop.id, isArchived: false },
      orderBy: { displayOrder: "asc" },
    }),
  ]);

  return {
    currencyCode: shop.currencyCode,
    page,
    total,
    pages: Math.max(1, Math.ceil(total / take)),
    filters: { q, tierId, approval, override, sync },
    tiers: tiers.map((t) => ({ id: t.id, name: t.name })),
    customers: customers.map((c) => ({
      id: c.id,
      name: c.displayName || c.email || c.shopifyCustomerId,
      spend: formatMoney(c.qualifyingSpendMinor, shop.currencyCode),
      tier: c.effectiveTier?.name ?? "—",
      discount: c.effectiveTier ? `${bpsToPercentString(c.effectiveTier.discountBps)}%` : "—",
      approved: c.businessApproved,
      override: Boolean(c.overrideTierId),
      pricingSyncStatus: c.pricingSyncStatus,
      historyStatus: c.historyStatus,
    })),
  };
};

export default function CustomersPage() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading="Customers">
      <PageIntro>
        Search by name, email, or Shopify ID. Open a row to approve business accounts, set overrides,
        or review spend history.
      </PageIntro>

      <s-section heading="Search & filters">
        <form method="get" className="vpm-filter-bar">
            <s-text-field name="q" label="Search" value={data.filters.q} />
            <label>
              Tier
              <select name="tier" defaultValue={data.filters.tierId}>
              <option value="">All tiers</option>
              {data.tiers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            </label>
            <label>
              Approval
              <select name="approval" defaultValue={data.filters.approval}>
              <option value="">Any approval</option>
              <option value="approved">Approved</option>
              <option value="pending">Not approved</option>
            </select>
            </label>
            <label>
              Override
              <select name="override" defaultValue={data.filters.override}>
              <option value="">Any override</option>
              <option value="yes">Has override</option>
            </select>
            </label>
            <label>
              Pricing sync
              <select name="sync" defaultValue={data.filters.sync}>
              <option value="">Any pricing sync</option>
              <option value="NOT_CONFIGURED">Not configured</option>
              <option value="SYNCED">Synced</option>
              <option value="FAILED">Failed</option>
              <option value="UNSUPPORTED">Unsupported</option>
            </select>
            </label>
            <s-button type="submit">Apply filters</s-button>
        </form>
      </s-section>

      <s-section heading={`Results (${data.total})`}>
        {data.customers.length === 0 ? (
          <EmptyState
            title="No matching customers"
            body="Start a historical import from Automation, or wait for order webhooks after install."
          >
            <s-button href="/app/automation">Open automation</s-button>
          </EmptyState>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Qualifying spend</s-table-header>
              <s-table-header>Effective tier</s-table-header>
              <s-table-header>Discount</s-table-header>
              <s-table-header>Approval</s-table-header>
              <s-table-header>Pricing sync</s-table-header>
              <s-table-header>History</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.customers.map((c) => (
                <s-table-row key={c.id}>
                  <s-table-cell>
                    <s-link href={`/app/customers/${c.id}`}>{c.name}</s-link>
                    {c.override ? <span className="vpm-tag">Override</span> : null}
                  </s-table-cell>
                  <s-table-cell>{c.spend}</s-table-cell>
                  <s-table-cell>{c.tier}</s-table-cell>
                  <s-table-cell>{c.discount}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={c.approved ? "success" : "warning"}>
                      {c.approved ? "Approved" : "Pending"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{pricingStatusLabel(c.pricingSyncStatus)}</s-table-cell>
                  <s-table-cell>{c.historyStatus}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        <s-paragraph>
          Page {data.page} of {data.pages}
          {data.page < data.pages ? (
            <>
              {" "}
              · <s-link href={`?page=${data.page + 1}`}>Next</s-link>
            </>
          ) : null}
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
