import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import { createForm } from "../services/forms/form-service";
import { PageIntro } from "../components/admin/ui";

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
  throw redirect(`/app/forms/${created.id}`);
};

export default function NewFormPage() {
  useLoaderData<typeof loader>();
  return (
    <s-page heading="Create form">
      <PageIntro>
        Choose a blank canvas or the editable Contractor Wholesale Application template. Templates use
        the same builder — nothing is hardcoded after creation.
      </PageIntro>
      <s-section heading="Start from">
        <Form method="post">
          <s-stack direction="block" gap="base">
            <s-text-field name="title" label="Form title" value="Untitled form" />
            <label>
              <input type="radio" name="template" value="blank" defaultChecked /> Blank form
            </label>
            <label>
              <input type="radio" name="template" value="contractor_wholesale" /> Contractor Wholesale
              Application (editable template)
            </label>
            <s-button type="submit">Create</s-button>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
