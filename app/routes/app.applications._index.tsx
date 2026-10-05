import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import { EmptyState, PageIntro } from "../components/admin/ui";
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
        Cross-form submissions inbox. Open a row to review answers, approve eligibility, and
        optionally set an audited starting-tier override.
      </PageIntro>

      <s-section heading="Filter">
        <Form method="get">
          <s-stack direction="inline" gap="base">
            <s-text-field name="q" label="Search" value={data.q} />
            <label>
              Status{" "}
              <select name="status" defaultValue={data.status}>
                <option value="">All</option>
                <option value="PENDING">PENDING</option>
                <option value="NEEDS_INFORMATION">NEEDS_INFORMATION</option>
                <option value="APPROVED">APPROVED</option>
                <option value="REJECTED">REJECTED</option>
                <option value="WITHDRAWN">WITHDRAWN</option>
              </select>
            </label>
            <s-button type="submit">Apply</s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading={`${data.total} application(s)`}>
        {data.submissions.length === 0 ? (
          <EmptyState
            title="No applications yet"
            body="Published forms will send submissions here."
          >
            <s-button href="/app/forms">Open forms</s-button>
          </EmptyState>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Applicant</s-table-header>
              <s-table-header>Form</s-table-header>
              <s-table-header>Company</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Submitted</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.submissions.map((s) => (
                <s-table-row key={s.id}>
                  <s-table-cell>
                    <s-link href={`/app/forms/${s.formId}/submissions/${s.id}`}>
                      {s.applicantName || s.applicantEmail || s.id}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <s-link href={`/app/forms/${s.formId}`}>{s.formTitle}</s-link>
                  </s-table-cell>
                  <s-table-cell>{s.companyName || "—"}</s-table-cell>
                  <s-table-cell>
                    <s-badge>{s.status}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{formatDateTime(s.submittedAt)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}

        {data.totalPages > 1 ? (
          <s-stack direction="inline" gap="base">
            {data.page > 1 ? (
              <s-link
                href={`?q=${encodeURIComponent(data.q)}&status=${encodeURIComponent(data.status)}&page=${data.page - 1}`}
              >
                Previous
              </s-link>
            ) : null}
            <span>
              Page {data.page} of {data.totalPages}
            </span>
            {data.page < data.totalPages ? (
              <s-link
                href={`?q=${encodeURIComponent(data.q)}&status=${encodeURIComponent(data.status)}&page=${data.page + 1}`}
              >
                Next
              </s-link>
            ) : null}
          </s-stack>
        ) : null}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
