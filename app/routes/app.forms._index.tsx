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
import { EmptyState, FlashBanner, PageIntro } from "../components/admin/ui";
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
      <s-button slot="primary-action" href="/app/forms/new">
        Create form
      </s-button>
      {actionData?.message ? <FlashBanner message={actionData.message} ok={actionData.ok} /> : null}
      <PageIntro>
        Build a form, publish it, then paste the handle into the theme app block. Review submissions
        under <s-link href="/app/applications">Applications</s-link>.
      </PageIntro>

      <s-section heading="Your forms">
        {forms.length === 0 ? (
          <EmptyState
            title="No forms yet"
            body="Start blank or use the Contractor Wholesale Application template — both use the same builder."
          >
            <s-button href="/app/forms/new">Create form</s-button>
          </EmptyState>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Title</s-table-header>
              <s-table-header>Handle</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Purpose</s-table-header>
              <s-table-header>Submissions</s-table-header>
              <s-table-header>Updated</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {forms.map((f) => (
                <s-table-row key={f.id}>
                  <s-table-cell>
                    <s-link href={`/app/forms/${f.id}`}>{f.title}</s-link>
                    <div className="vpm-change-meta">
                      <s-link href={`/app/forms/${f.id}/embed`}>Embed</s-link>
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
                  </s-table-cell>
                  <s-table-cell>
                    <code className="vpm-code">{f.handle}</code>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={f.status === "PUBLISHED" ? "success" : undefined}>{f.status}</s-badge>
                    {f.publishedVersion ? ` v${f.publishedVersion}` : ""}
                  </s-table-cell>
                  <s-table-cell>{f.purpose}</s-table-cell>
                  <s-table-cell>
                    <s-link href={`/app/forms/${f.id}/submissions`}>{f.submissions}</s-link>
                  </s-table-cell>
                  <s-table-cell>{formatDateTime(f.updatedAt)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
