import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import { createForm } from "../services/forms/form-service";
import { AdminLink, Field, PageIntro, SubmitButton } from "../components/admin/ui";
import { withEmbeddedSearch } from "../lib/embedded-nav";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {};
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const form = await request.formData();
  const created = await createForm(prisma, {
    shopId: shop.id,
    shopDomain: session.shop,
    title: String(form.get("title") || "Untitled form"),
    fromTemplate: String(form.get("template") || "blank") as "blank" | "contractor_wholesale",
  });
  throw redirect(withEmbeddedSearch(`/app/forms/${created.id}`, new URL(request.url).search));
};

export default function NewFormPage() {
  useLoaderData<typeof loader>();
  return (
    <s-page heading="Create form">
      <div slot="breadcrumb-actions">
        <AdminLink to="/app/forms">← Forms</AdminLink>
      </div>
      <PageIntro>
        Choose a blank canvas or the editable Contractor Wholesale Application template. Templates use
        the same builder — nothing is hardcoded after creation.
      </PageIntro>
      <s-section heading="Start from">
        <div className="vpm-panel">
          <Form method="post" className="vpm-form-stack">
            <Field
              label="Form title"
              name="title"
              placeholder="e.g. Contractor wholesale application"
              required
            />
            <label className="vpm-check">
              <input type="radio" name="template" value="blank" defaultChecked /> Blank form
            </label>
            <label className="vpm-check">
              <input type="radio" name="template" value="contractor_wholesale" /> Contractor Wholesale
              Application (editable template)
            </label>
            <SubmitButton>Create</SubmitButton>
          </Form>
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
