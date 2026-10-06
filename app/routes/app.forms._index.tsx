import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import {
  archiveForm,
  createForm,
  duplicateForm,
  listForms,
} from "../services/forms/form-service";
import { EmptyState, FlashBanner, PageIntro, AdminLink } from "../components/admin/ui";
import { formatDateTime } from "../lib/format";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const forms = await listForms(prisma, shop.id);
  return {
    forms: forms.map((f) => ({
      id: f.id,
      title: f.title,
      handle: f.handle,
      status: f.status,
      purpose: f.purpose,
      publishedVersion: f.publishedVersion,
      submissions: f._count.submissions,
      updatedAt: f.updatedAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  try {
    if (intent === "create") {
      const created = await createForm(prisma, {
        shopId: shop.id,
        shopDomain: session.shop,
        title: String(form.get("title") || "Untitled form"),
        fromTemplate: String(form.get("template") || "blank") as "blank" | "contractor_wholesale",
      });
      throw redirect(`/app/forms/${created.id}`);
    }
    if (intent === "duplicate") {
      const dup = await duplicateForm(prisma, shop.id, session.shop, String(form.get("formId")));
      throw redirect(`/app/forms/${dup.id}`);
    }
    if (intent === "archive") {
      await archiveForm(prisma, shop.id, session.shop, String(form.get("formId")));
      return { ok: true, message: "Form archived." };
    }
  } catch (err) {
    if (err instanceof Response) throw err;
    return { ok: false, message: err instanceof Error ? err.message : "Failed" };
  }
  return { ok: false, message: "Unknown action" };
};

export default function FormsIndex() {
  const { forms } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Forms">
      <div slot="primary-action">
        <AdminLink to="/app/forms/new" className="vpm-btn">
          Create form
        </AdminLink>
      </div>
      {actionData?.message ? <FlashBanner message={actionData.message} ok={actionData.ok} /> : null}
      <PageIntro>
        Build a form, publish it, then paste the handle into the theme app block. Review submissions
        under <AdminLink to="/app/applications">Applications</AdminLink>.
      </PageIntro>

      <s-section heading="Your forms">
        {forms.length === 0 ? (
          <EmptyState
            title="No forms yet"
            body="Start blank or use the Contractor Wholesale Application template — both use the same builder."
          >
            <AdminLink to="/app/forms/new" className="vpm-btn">
              Create form
            </AdminLink>
          </EmptyState>
        ) : (
          <div className="vpm-panel" style={{ padding: 0, overflow: "auto" }}>
            <table className="vpm-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Handle</th>
                  <th>Status</th>
                  <th>Purpose</th>
                  <th>Submissions</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {forms.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <AdminLink to={`/app/forms/${f.id}`}>{f.title}</AdminLink>
                      <div className="vpm-change-meta">
                        <AdminLink to={`/app/forms/${f.id}/embed`}>Embed</AdminLink>
                        {" · "}
                        <Form method="post" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="duplicate" />
                          <input type="hidden" name="formId" value={f.id} />
                          <button type="submit" className="vpm-linkish">
                            Duplicate
                          </button>
                        </Form>
                        {" · "}
                        <Form method="post" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="archive" />
                          <input type="hidden" name="formId" value={f.id} />
                          <button type="submit" className="vpm-linkish vpm-linkish--critical">
                            Archive
                          </button>
                        </Form>
                      </div>
                    </td>
                    <td>
                      <code className="vpm-code">{f.handle}</code>
                    </td>
                    <td>
                      <s-badge tone={f.status === "PUBLISHED" ? "success" : undefined}>
                        {f.status}
                      </s-badge>
                      {f.publishedVersion ? ` v${f.publishedVersion}` : ""}
                    </td>
                    <td>{f.purpose}</td>
                    <td>
                      <AdminLink to={`/app/forms/${f.id}/submissions`}>{f.submissions}</AdminLink>
                    </td>
                    <td>{formatDateTime(f.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
