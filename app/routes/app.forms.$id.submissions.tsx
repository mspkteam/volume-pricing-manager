import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import { getForm } from "../services/forms/form-service";
import { EmptyState, PageIntro } from "../components/admin/ui";
import { formatDateTime } from "../lib/format";

const PAGE_SIZE = 25;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const form = await getForm(prisma, shop.id, String(params.id));
  if (!form) throw new Response("Form not found", { status: 404 });

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const status = (url.searchParams.get("status") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));

  const where = {
    shopId: shop.id,
    formId: form.id,
    ...(status ? { status: status as never } : {}),
    ...(q
      ? {
          OR: [
            { applicantEmail: { contains: q, mode: "insensitive" as const } },
            { applicantName: { contains: q, mode: "insensitive" as const } },
            { companyName: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [total, submissions] = await Promise.all([
    prisma.formSubmissions.count({ where }),
    prisma.formSubmissions.findMany({
      where,
      orderBy: { submittedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        status: true,
        applicantName: true,
        applicantEmail: true,
        companyName: true,
        identityKind: true,
        submittedAt: true,
        requestedTierSnapshot: true,
      },
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return {
    form: { id: form.id, title: form.title, handle: form.handle },
    q,
    status,
    page,
    total,
    totalPages,
    submissions: submissions.map((s) => ({
      id: s.id,
      status: s.status,
      applicantName: s.applicantName,
      applicantEmail: s.applicantEmail,
      companyName: s.companyName,
      identityKind: s.identityKind,
      submittedAt: s.submittedAt.toISOString(),
      requestedTier:
        s.requestedTierSnapshot &&
        typeof s.requestedTierSnapshot === "object" &&
        "name" in (s.requestedTierSnapshot as object)
          ? String((s.requestedTierSnapshot as { name?: string }).name || "")
          : null,
    })),
  };
};

export default function FormSubmissionsPage() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading={`Submissions · ${data.form.title}`}>
      <s-button slot="primary-action" href={`/app/forms/${data.form.id}`} variant="tertiary">
        Back to builder
      </s-button>
      <PageIntro>
        Review applications for <code>{data.form.handle}</code>. Application status is separate from
        pricing sync after approval.
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

      <s-section heading={`${data.total} submission(s)`}>
        {data.submissions.length === 0 ? (
          <EmptyState title="No submissions" body="Matching applications will appear here." />
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Applicant</s-table-header>
              <s-table-header>Company</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Identity</s-table-header>
              <s-table-header>Requested tier</s-table-header>
              <s-table-header>Submitted</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.submissions.map((s) => (
                <s-table-row key={s.id}>
                  <s-table-cell>
                    <s-link href={`/app/forms/${data.form.id}/submissions/${s.id}`}>
                      {s.applicantName || s.applicantEmail || s.id}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>{s.companyName || "—"}</s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone={
                        s.status === "APPROVED"
                          ? "success"
                          : s.status === "REJECTED"
                            ? "critical"
                            : undefined
                      }
                    >
                      {s.status}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{s.identityKind}</s-table-cell>
                  <s-table-cell>{s.requestedTier || "—"}</s-table-cell>
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
