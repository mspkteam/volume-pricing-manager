import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import { getForm } from "../services/forms/form-service";
import { AdminLink, PageIntro } from "../components/admin/ui";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const form = await getForm(prisma, shop.id, String(params.id));
  if (!form) throw new Response("Form not found", { status: 404 });

  const apiKey = process.env.SHOPIFY_API_KEY || "";
  const shopDomain = session.shop.replace(/\.myshopify\.com$/i, "");
  // Deep link opens Theme Editor with this app embed ready to enable
  const embedDeepLink = apiKey
    ? `https://${session.shop}/admin/themes/current/editor?context=apps&activateAppId=${apiKey}/app-embed`
    : null;
  const blockDeepLink = apiKey
    ? `https://${session.shop}/admin/themes/current/editor?template=page&addAppBlockId=${apiKey}/application-form&target=newAppsSection`
    : null;

  return {
    form: {
      id: form.id,
      title: form.title,
      handle: form.handle,
      status: form.status,
      publishedVersion: form.publishedVersion,
    },
    proxyPath: `/apps/volume-pricing/forms/${form.id}`,
    handleProxyPath: `/apps/volume-pricing/forms/${form.handle}`,
    embedDeepLink,
    blockDeepLink,
    shopDomain,
  };
};

export default function FormEmbedPage() {
  const data = useLoaderData<typeof loader>();
  const { form } = data;

  return (
    <s-page heading={`Embed · ${form.title}`}>
      <div slot="breadcrumb-actions">
        <AdminLink to={`/app/forms/${form.id}`}>← Form builder</AdminLink>
      </div>

      <PageIntro>
        Enable the App embed once, then place the Form widget on any page with this Form ID — same
        pattern as other Shopify apps.
      </PageIntro>

      <s-section heading="Form ID">
        <div className="vpm-panel vpm-stack-tight">
          <s-paragraph>
            <s-text type="strong">Form ID</s-text>
          </s-paragraph>
          <p>
            <code className="vpm-code">{form.id}</code>
          </p>
          <s-paragraph>
            Handle (also works): <code className="vpm-code">{form.handle}</code>
          </s-paragraph>
          {form.status !== "PUBLISHED" ? (
            <s-banner tone="warning">
              Status is <strong>{form.status}</strong>. Publish the form before customers can submit.
            </s-banner>
          ) : (
            <s-banner tone="success">Published v{form.publishedVersion}</s-banner>
          )}
        </div>
      </s-section>

      <s-section heading="1. Enable App embed">
        <s-unordered-list>
          <s-list-item>Online Store → Themes → Customize</s-list-item>
          <s-list-item>Open the theme settings (left) → <strong>App embeds</strong></s-list-item>
          <s-list-item>
            Turn on <strong>Volume Pricing</strong>
          </s-list-item>
          <s-list-item>Save</s-list-item>
        </s-unordered-list>
        {data.embedDeepLink ? (
          <p className="vpm-meta-row">
            <a className="vpm-btn" href={data.embedDeepLink} target="_blank" rel="noreferrer">
              Open App embeds
            </a>
          </p>
        ) : null}
      </s-section>

      <s-section heading="2. Add the Form widget">
        <s-unordered-list>
          <s-list-item>In the theme editor, open the page (e.g. Applications)</s-list-item>
          <s-list-item>
            Add block / section → Apps → <strong>Volume Pricing Form</strong>
          </s-list-item>
          <s-list-item>
            Paste Form ID: <code>{form.id}</code>
          </s-list-item>
          <s-list-item>Save</s-list-item>
        </s-unordered-list>
        {data.blockDeepLink ? (
          <p className="vpm-meta-row">
            <a className="vpm-btn vpm-btn--secondary" href={data.blockDeepLink} target="_blank" rel="noreferrer">
              Add form block to a page
            </a>
          </p>
        ) : null}
      </s-section>

      <s-section heading="Optional: custom Liquid / HTML">
        <s-paragraph>
          With the App embed enabled, you can also drop this widget anywhere custom Liquid is allowed:
        </s-paragraph>
        <pre className="vpm-code" style={{ whiteSpace: "pre-wrap", padding: "0.75rem" }}>
{`<div data-vpm-form data-form-id="${form.id}"></div>`}
        </pre>
        <s-paragraph>
          Or via JavaScript:{" "}
          <code>{`VPMForm.render('#my-el', { formId: '${form.id}' })`}</code>
        </s-paragraph>
        <s-paragraph>
          API path: <code>{data.proxyPath}</code> (ID) · <code>{data.handleProxyPath}</code> (handle)
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
