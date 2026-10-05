import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import { getForm } from "../services/forms/form-service";
import { PageIntro } from "../components/admin/ui";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const form = await getForm(prisma, shop.id, String(params.id));
  if (!form) throw new Response("Form not found", { status: 404 });

  return {
    form: {
      id: form.id,
      title: form.title,
      handle: form.handle,
      status: form.status,
      publishedVersion: form.publishedVersion,
    },
    proxyPath: `/apps/volume-pricing/forms/${form.handle}`,
  };
};

export default function FormEmbedPage() {
  const { form, proxyPath } = useLoaderData<typeof loader>();

  return (
    <s-page heading={`Embed · ${form.title}`}>
      <s-button slot="primary-action" href={`/app/forms/${form.id}`} variant="tertiary">
        Back to builder
      </s-button>
      <PageIntro>
        Publish the form, then add the Volume Pricing Form theme app block and paste the handle
        below. Theme Editor cannot dynamically list forms, so merchants must paste the handle into
        the text setting.
      </PageIntro>

      <s-section heading="Form handle">
        <s-banner tone="info">
          Handle: <code>{form.handle}</code>
          {form.status !== "PUBLISHED" ? (
            <>
              {" "}
              — this form is <strong>{form.status}</strong>. Publish before embedding on the
              storefront.
            </>
          ) : (
            <>
              {" "}
              · published v{form.publishedVersion}
            </>
          )}
        </s-banner>
        <s-paragraph>
          App proxy path: <code>{proxyPath}</code>
        </s-paragraph>
      </s-section>

      <s-section heading="Theme editor steps">
        <s-unordered-list>
          <s-list-item>Open Online Store → Themes → Customize.</s-list-item>
          <s-list-item>Add section or block → Apps → Volume Pricing Form.</s-list-item>
          <s-list-item>
            Paste <code>{form.handle}</code> into the Form handle setting.
          </s-list-item>
          <s-list-item>Optional: adjust colors, spacing, and button style in the block settings.</s-list-item>
          <s-list-item>Save the theme.</s-list-item>
        </s-unordered-list>
        <s-paragraph>
          The block loads the published schema from{" "}
          <code>/apps/volume-pricing/forms/{"{handle}"}</code> via the app proxy. Submissions POST to
          the same path with <code>/submit</code>; uploads use <code>/upload</code>.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
