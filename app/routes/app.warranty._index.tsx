import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import {
  AdminLink,
  EmptyState,
  Field,
  PageIntro,
  WarrantyStatusBadge,
  buildQuery,
} from "../components/admin/ui";
import { formatDateTime } from "../lib/format";
import { ensureWarrantySettings } from "../services/warranty/settings";

const PAGE_SIZE = 30;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  await ensureWarrantySettings(prisma, shop.id);

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const status = (url.searchParams.get("status") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));

  const where = {
    shopId: shop.id,
    ...(status ? { status: status as never } : {}),
    ...(q
      ? {
          OR: [
            { claimNumber: { contains: q, mode: "insensitive" as const } },
            { customerEmail: { contains: q, mode: "insensitive" as const } },
            { customerName: { contains: q, mode: "insensitive" as const } },
            { productSku: { contains: q, mode: "insensitive" as const } },
            { orderNumber: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.warrantyClaims.count({ where }),
    prisma.warrantyClaims.findMany({
      where,
      orderBy: { submittedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  return {
    q,
    status,
    page,
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    claims: rows.map((c) => ({
      id: c.id,
      claimNumber: c.claimNumber,
      status: c.status,
      customerName: c.customerName,
      customerEmail: c.customerEmail,
      productSku: c.productSku,
      orderNumber: c.orderNumber,
      withinWarrantyWindow: c.withinWarrantyWindow,
      submittedAt: c.submittedAt.toISOString(),
    })),
  };
};

export default function WarrantyInbox() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading="Warranty claims">
      <PageIntro>
        Storefront warranty claims land here. Approve a claim and optionally create a shipping
        &amp; handling draft-order invoice for the replacement.{" "}
        <AdminLink to="/app/warranty/settings">Warranty settings</AdminLink>
      </PageIntro>

      <s-section heading="Filter">
        <Form method="get" className="vpm-filter-bar">
          <Field label="Search" name="q" defaultValue={data.q} />
          <label>
            Status
            <select name="status" defaultValue={data.status}>
              <option value="">All</option>
              <option value="PENDING">Pending</option>
              <option value="NEEDS_INFORMATION">Needs information</option>
              <option value="APPROVED">Approved</option>
              <option value="INVOICE_SENT">Invoice sent</option>
              <option value="REJECTED">Rejected</option>
              <option value="CLOSED">Closed</option>
            </select>
          </label>
          <button type="submit" className="vpm-btn">
            Apply
          </button>
        </Form>
      </s-section>

      <s-section heading={`Claims (${data.total})`}>
        {data.claims.length === 0 ? (
          <EmptyState
            title="No warranty claims yet"
            body="When customers submit the Warranty Claims page form, they will appear here."
          />
        ) : (
          <div className="vpm-table-wrap">
            <table className="vpm-table">
              <thead>
                <tr>
                  <th>Claim</th>
                  <th>Customer</th>
                  <th>SKU</th>
                  <th>Window</th>
                  <th>Status</th>
                  <th>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {data.claims.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <AdminLink to={`/app/warranty/${c.id}`}>{c.claimNumber}</AdminLink>
                    </td>
                    <td>
                      {c.customerName || "—"}
                      <br />
                      <span className="vpm-muted">{c.customerEmail}</span>
                    </td>
                    <td>
                      {c.productSku}
                      {c.orderNumber ? (
                        <>
                          <br />
                          <span className="vpm-muted">Order {c.orderNumber}</span>
                        </>
                      ) : null}
                    </td>
                    <td>
                      {c.withinWarrantyWindow == null
                        ? "Unknown"
                        : c.withinWarrantyWindow
                          ? "In window"
                          : "Outside window"}
                    </td>
                    <td>
                      <WarrantyStatusBadge status={c.status} />
                    </td>
                    <td>{formatDateTime(c.submittedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.totalPages > 1 ? (
          <div className="vpm-actions" style={{ marginTop: 16 }}>
            {data.page > 1 ? (
              <AdminLink
                to={`/app/warranty${buildQuery({
                  q: data.q,
                  status: data.status,
                  page: data.page - 1,
                })}`}
              >
                Previous
              </AdminLink>
            ) : null}
            <span className="vpm-muted">
              Page {data.page} of {data.totalPages}
            </span>
            {data.page < data.totalPages ? (
              <AdminLink
                to={`/app/warranty${buildQuery({
                  q: data.q,
                  status: data.status,
                  page: data.page + 1,
                })}`}
              >
                Next
              </AdminLink>
            ) : null}
          </div>
        ) : null}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
