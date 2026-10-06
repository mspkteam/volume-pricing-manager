import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import { formatMoney, bpsToPercentString } from "../lib/money";
import { EmptyState, PageIntro, buildQuery, AdminLink, Field, SubmitButton } from "../components/admin/ui";
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
          <Field label="Search" name="q" defaultValue={data.filters.q} placeholder="Name, email, or ID" />
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
              <option value="">Any</option>
              <option value="approved">Approved</option>
              <option value="pending">Not approved</option>
            </select>
          </label>
          <input type="hidden" name="override" value={data.filters.override} />
          <input type="hidden" name="sync" value={data.filters.sync} />
          <SubmitButton>Apply</SubmitButton>
        </form>
      </s-section>

      <s-section heading={`Results (${data.total})`}>
        {data.customers.length === 0 ? (
          <EmptyState
            title="No matching customers"
            body="Start a historical import from Automation, or wait for order webhooks after install."
          >
            <AdminLink to="/app/automation" className="vpm-btn">
              Open automation
            </AdminLink>
          </EmptyState>
        ) : (
          <div className="vpm-panel" style={{ padding: 0, overflow: "auto" }}>
            <table className="vpm-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Qualifying spend</th>
                  <th>Effective tier</th>
                  <th>Discount</th>
                  <th>Approval</th>
                  <th>Pricing sync</th>
                  <th>History</th>
                </tr>
              </thead>
              <tbody>
                {data.customers.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <AdminLink to={`/app/customers/${c.id}`}>{c.name}</AdminLink>
                      {c.override ? <span className="vpm-tag">Override</span> : null}
                    </td>
                    <td>{c.spend}</td>
                    <td>{c.tier}</td>
                    <td>{c.discount}</td>
                    <td>
                      <s-badge tone={c.approved ? "success" : "warning"}>
                        {c.approved ? "Approved" : "Pending"}
                      </s-badge>
                    </td>
                    <td>{pricingStatusLabel(c.pricingSyncStatus)}</td>
                    <td>{c.historyStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="vpm-pagination">
          <span>
            Page {data.page} of {data.pages}
          </span>
          {data.page > 1 ? (
            <AdminLink
              to={buildQuery({
                q: data.filters.q,
                tier: data.filters.tierId,
                approval: data.filters.approval,
                override: data.filters.override,
                sync: data.filters.sync,
                page: data.page - 1,
              })}
            >
              Previous
            </AdminLink>
          ) : null}
          {data.page < data.pages ? (
            <AdminLink
              to={buildQuery({
                q: data.filters.q,
                tier: data.filters.tierId,
                approval: data.filters.approval,
                override: data.filters.override,
                sync: data.filters.sync,
                page: data.page + 1,
              })}
            >
              Next
            </AdminLink>
          ) : null}
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
