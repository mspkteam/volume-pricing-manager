import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import {
  AdminLink,
  ApplicationStatusBadge,
  EmptyState,
  Field,
  PageIntro,
  SubmitButton,
} from "../components/admin/ui";
import { formatDateTime } from "../lib/format";

const PAGE_SIZE = 30;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
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
            { applicantEmail: { contains: q, mode: "insensitive" as const } },
            { applicantName: { contains: q, mode: "insensitive" as const } },
            { companyName: { contains: q, mode: "insensitive" as const } },
            { form: { title: { contains: q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.formSubmissions.count({ where }),
    prisma.formSubmissions.findMany({
      where,
      orderBy: { submittedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        form: { select: { id: true, title: true, handle: true } },
      },
    }),
  ]);

  return {
    q,
    status,
    page,
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    submissions: rows.map((s) => ({
      id: s.id,
      status: s.status,
      applicantName: s.applicantName,
      applicantEmail: s.applicantEmail,
      companyName: s.companyName,
      submittedAt: s.submittedAt.toISOString(),
      formId: s.form.id,
      formTitle: s.form.title,
      formHandle: s.form.handle,
    })),
  };
};

export default function ApplicationsInbox() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading="Applications">
      <PageIntro>
        Review buyer applications here. Approve only when the applicant submitted while logged in —
        that unlocks wholesale tags on the storefront.
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
              <option value="REJECTED">Rejected</option>
              <option value="WITHDRAWN">Withdrawn</option>
            </select>
          </label>
          <SubmitButton>Apply</SubmitButton>
        </Form>
      </s-section>

      <s-section heading={`${data.total} application(s)`}>
        {data.submissions.length === 0 ? (
          <EmptyState title="No applications yet" body="Published forms will send submissions here.">
            <AdminLink to="/app/forms" className="vpm-btn">
              Open forms
            </AdminLink>
          </EmptyState>
        ) : (
          <div className="vpm-panel" style={{ padding: 0, overflow: "auto" }}>
            <table className="vpm-table">
              <thead>
                <tr>
                  <th>Applicant</th>
                  <th>Form</th>
                  <th>Company</th>
                  <th>Status</th>
                  <th>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {data.submissions.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <AdminLink to={`/app/forms/${s.formId}/submissions/${s.id}`}>
                        {s.applicantName || s.applicantEmail || s.id}
                      </AdminLink>
                    </td>
                    <td>
                      <AdminLink to={`/app/forms/${s.formId}`}>{s.formTitle}</AdminLink>
                    </td>
                    <td>{s.companyName || "—"}</td>
                    <td>
                      <ApplicationStatusBadge status={s.status} />
                    </td>
                    <td>{formatDateTime(s.submittedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data.totalPages > 1 ? (
          <div className="vpm-pagination">
            {data.page > 1 ? (
              <AdminLink
                to={`?q=${encodeURIComponent(data.q)}&status=${encodeURIComponent(data.status)}&page=${data.page - 1}`}
              >
                Previous
              </AdminLink>
            ) : null}
            <span>
              Page {data.page} of {data.totalPages}
            </span>
            {data.page < data.totalPages ? (
              <AdminLink
                to={`?q=${encodeURIComponent(data.q)}&status=${encodeURIComponent(data.status)}&page=${data.page + 1}`}
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

export const headers: HeadersFunction = (h) => boundary.headers(h);
