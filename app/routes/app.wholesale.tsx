import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import {
  DEFAULT_WHOLESALE_ACCESS_POLICY,
  parseWholesaleAccessPolicy,
  type WholesaleLockMode,
} from "../services/wholesale/policy";
import { AdminLink, EmptyState, Field, FlashBanner, PageIntro, SubmitButton } from "../components/admin/ui";
import { writeAuditLog } from "../services/audit/audit-log";
import { enqueueJob, JOB_TYPES } from "../services/jobs/queue";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const policy = parseWholesaleAccessPolicy(shop.wholesaleAccessPolicy);
  const tiers = await prisma.pricingTier.findMany({
    where: { shopId: shop.id, isArchived: false },
    orderBy: { displayOrder: "asc" },
  });
  return {
    policy,
    defaults: DEFAULT_WHOLESALE_ACCESS_POLICY,
    tiers: tiers.map((t) => ({
      id: t.id,
      name: t.name,
      discountPct: (t.discountBps / 100).toFixed(0),
    })),
    pricingWrites: process.env.PRICING_WRITES_ENABLED === "true",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    if (intent === "save") {
      const policy = parseWholesaleAccessPolicy({
        syncCustomerTags: form.get("syncCustomerTags") === "on",
        managedTagPrefix: String(form.get("managedTagPrefix") || "vpm"),
        approvedTag: String(form.get("approvedTag") || "vpm-approved"),
        writePercentTag: form.get("writePercentTag") === "on",
        lockMode: String(form.get("lockMode") || "approved_only") as WholesaleLockMode,
        lockMessage: String(form.get("lockMessage") || ""),
        loginMessage: String(form.get("loginMessage") || ""),
      });
      await prisma.shop.update({
        where: { id: shop.id },
        data: { wholesaleAccessPolicy: policy },
      });
      await writeAuditLog(prisma, {
        shopId: shop.id,
        actor: session.shop,
        action: "wholesale.policy_saved",
        entityType: "Shop",
        entityId: shop.id,
        summary: "Updated wholesale access / lock policy",
      });
      return { ok: true, message: "Wholesale access settings saved." };
    }
    if (intent === "resync_tags") {
      const customers = await prisma.customerProfiles.findMany({
        where: { shopId: shop.id },
        select: { id: true },
        take: 500,
      });
      for (const c of customers) {
        await enqueueJob(prisma, {
          shopDomain: session.shop,
          shopId: shop.id,
          type: JOB_TYPES.SYNC_WHOLESALE_ACCESS,
          payload: { customerProfileId: c.id },
          idempotencyKey: `resync-access:${c.id}:${Date.now()}`,
        });
      }
      return {
        ok: true,
        message: `Queued tag sync for ${customers.length} customers. Ensure the worker is running.`,
      };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Failed" };
  }
  return { ok: false, message: "Unknown action" };
};

export default function WholesaleAccessPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const p = data.policy;

  return (
    <s-page heading="Wholesale access">
      {actionData?.message ? <FlashBanner message={actionData.message} ok={actionData.ok} /> : null}

      <PageIntro>
        Clay-like B2B wholesale for your store — automated. Approved customers get Shopify tags that unlock
        storefront prices and catalog access. Checkout Discount Function sync is separate (
        {data.pricingWrites ? "writes enabled" : "writes currently disabled"}).
      </PageIntro>

      <s-section heading="How it works">
        <s-unordered-list>
          <s-list-item>Customer applies via your Forms widget (replaces Clay registration).</s-list-item>
          <s-list-item>You approve → app sets business eligibility and runs the tier engine.</s-list-item>
          <s-list-item>
            App tags the Shopify customer (e.g. <code>vpm-approved</code>, tier name,{" "}
            <code>vpm-pct-30</code>) so the theme can show wholesale rates like Clay.
          </s-list-item>
          <s-list-item>
            Theme lock snippet hides prices / ATC until those tags exist (Clay Lock replacement).
          </s-list-item>
          <s-list-item>Orders update spend → tiers update → tags refresh automatically.</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Your tiers → storefront tags">
        {data.tiers.length === 0 ? (
          <EmptyState
            title="No pricing tiers yet"
            body="Create tiers named like Wholesale / Distributor / Retailer so storefront tags match your Clay-compatible theme."
          >
            <AdminLink to="/app/tiers" className="vpm-btn">
              Create tiers
            </AdminLink>
          </EmptyState>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Tier name (tag)</s-table-header>
              <s-table-header>Discount</s-table-header>
              <s-table-header>Auto tags</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.tiers.map((t) => (
                <s-table-row key={t.id}>
                  <s-table-cell>{t.name}</s-table-cell>
                  <s-table-cell>{t.discountPct}%</s-table-cell>
                  <s-table-cell>
                    <code>{t.name}</code>, <code>vpm-pct-{t.discountPct}</code>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Access & lock settings">
        <div className="vpm-panel">
          <Form method="post" className="vpm-form-stack">
            <input type="hidden" name="intent" value="save" />
            <label className="vpm-check">
              <input type="checkbox" name="syncCustomerTags" defaultChecked={p.syncCustomerTags} />
              Sync Shopify customer tags from approval + effective tier
            </label>
            <label className="vpm-check">
              <input type="checkbox" name="writePercentTag" defaultChecked={p.writePercentTag} />
              Write <code className="vpm-code">vpm-pct-N</code> tags (theme reads exact %)
            </label>
            <Field
              name="managedTagPrefix"
              label="Managed tag prefix"
              defaultValue={p.managedTagPrefix}
            />
            <Field name="approvedTag" label="Approved customer tag" defaultValue={p.approvedTag} />
            <label className="vpm-field">
              Lock mode
              <select name="lockMode" defaultValue={p.lockMode}>
                <option value="off">Off (theme may still lock)</option>
                <option value="login_required">Login required</option>
                <option value="approved_only">Approved only (recommended)</option>
                <option value="tier_tagged">Has any VPM / tier tag</option>
              </select>
            </label>
            <Field name="lockMessage" label="Locked (logged-in) message" defaultValue={p.lockMessage} />
            <Field name="loginMessage" label="Guest login message" defaultValue={p.loginMessage} />
            <SubmitButton>Save settings</SubmitButton>
          </Form>
        </div>
      </s-section>

      <s-section heading="Actions">
        <Form method="post">
          <input type="hidden" name="intent" value="resync_tags" />
          <SubmitButton variant="secondary">Re-sync tags for all customers</SubmitButton>
        </Form>
        <s-paragraph>
          Also: publish a form under <AdminLink to="/app/forms">Forms</AdminLink>, then in Theme
          Editor replace the Clay registration block on the Applications page with the Volume Pricing
          form block.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
