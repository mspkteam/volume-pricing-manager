import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  EmbeddedSLink,
  FlashBanner,
  PageIntro,
  SubmitButton,
} from "../components/admin/ui";
import {
  equipmentCatalogSummary,
  setupEquipmentCatalog,
} from "../services/catalog/equipment-setup";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { summary: equipmentCatalogSummary() };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  if (String(formData.get("intent")) !== "setup_equipment_catalog") {
    return { ok: false, message: "Unknown action" };
  }

  try {
    const result = await setupEquipmentCatalog(admin);
    const parts = [
      `Collections: ${result.collectionsCreated} created, ${result.collectionsExisting} already existed.`,
      `Metafields: ${result.metafieldsCreated} created, ${result.metafieldsExisting} already existed.`,
    ];
    if (result.pageCreated) parts.push("Equipment page created.");
    else if (result.pageExisting) parts.push("Equipment page already existed.");
    else if (result.pageSkipped) parts.push(result.pageSkipped);

    return {
      ok: true,
      message: parts.join(" "),
      result,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Setup failed",
    };
  }
};

export default function EquipmentSetupPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const s = data.summary;

  return (
    <s-page heading="Equipment catalog setup">
      <EmbeddedSLink slot="breadcrumb-actions" href="/app/settings">
        Settings
      </EmbeddedSLink>

      {actionData?.message ? (
        <FlashBanner message={actionData.message} ok={actionData.ok} />
      ) : null}

      <PageIntro>
        One-click bootstrap for the HVAC Equipment catalog from the client brief: collections,
        product metafield definitions (<code>{s.namespace}.*</code>), and the Equipment page.
        Safe to run more than once — existing handles are skipped.
      </PageIntro>

      <s-section heading="What will be created">
        <div className="vpm-panel vpm-stack-tight">
          <s-paragraph>
            <strong>{s.topCategoryCount}</strong> top categories ·{" "}
            <strong>{s.collectionCount}</strong> total collections (including subcategories)
          </s-paragraph>
          <s-paragraph>
            <strong>{s.metafieldCount}</strong> product metafields under namespace{" "}
            <code>{s.namespace}</code>
          </s-paragraph>
          <s-paragraph>
            Hub page handle: <code>/pages/{s.hubPageHandle}</code> (template{" "}
            <code>page.equipment</code>)
          </s-paragraph>
        </div>
      </s-section>

      <s-section heading="Run setup">
        <Form method="post" className="vpm-panel vpm-stack">
          <input type="hidden" name="intent" value="setup_equipment_catalog" />
          <s-paragraph>
            This uses the Volume Pricing Manager Admin API session (write_products). After it
            finishes, assign products into collections and enable the metafields in Search &amp;
            Discovery → Filters.
          </s-paragraph>
          <SubmitButton disabled={busy}>
            {busy ? "Creating collections & metafields…" : "Create collections & metafields"}
          </SubmitButton>
        </Form>
      </s-section>

      <s-section heading="Still needed after setup">
        <div className="vpm-panel vpm-stack-tight">
          <s-paragraph>1. Upload collection images (client thumbnails).</s-paragraph>
          <s-paragraph>2. Assign products to the right collections.</s-paragraph>
          <s-paragraph>
            3. Fill product metafield values (tonnage, SEER2, refrigerant, etc.) — can be bulk CSV
            later.
          </s-paragraph>
          <s-paragraph>4. Turn on storefront filters in Search &amp; Discovery.</s-paragraph>
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
