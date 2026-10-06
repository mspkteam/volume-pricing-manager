import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import {
  applyStarterPreset,
  createTier,
  listTiers,
  reorderTiers,
} from "../services/tiers/tier-service";
import { buildSpendRanges } from "../lib/policies";
import { formatMoney, bpsToPercentString } from "../lib/money";
import { EmptyState, FlashBanner, PageIntro, TierName } from "../components/admin/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const tiers = await listTiers(prisma, shop.id);
  const ranges = buildSpendRanges(tiers);
  return {
    currencyCode: shop.currencyCode,
    tiers: tiers.map((t) => {
      const range = ranges.find((r) => r.id === t.id);
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        badgeColor: t.badgeColor,
        discount: bpsToPercentString(t.discountBps),
        minSpend: formatMoney(t.minSpendMinor, shop.currencyCode),
        rangeLabel:
          range?.maxSpendMinorExclusive == null
            ? `${formatMoney(t.minSpendMinor, shop.currencyCode)}+`
            : `${formatMoney(t.minSpendMinor, shop.currencyCode)} – under ${formatMoney(range.maxSpendMinorExclusive, shop.currencyCode)}`,
        requiresApproval: t.requiresApproval,
        isActive: t.isActive,
        isFallback: t.isFallback,
        assigned: t._count.assignments,
        displayOrder: t.displayOrder,
      };
    }),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    if (intent === "preset") {
      await applyStarterPreset(prisma, shop.id, session.shop);
      return { ok: true, message: "Starter preset applied. You can rename or edit any tier." };
    }
    if (intent === "create") {
      await createTier(
        prisma,
        shop.id,
        {
          name: String(form.get("name") || "").trim(),
          description: String(form.get("description") || ""),
          badgeColor: String(form.get("badgeColor") || "#5C6AC4"),
          minSpend: String(form.get("minSpend") || "0"),
          discountPercent: Number(form.get("discountPercent") || 0),
          requiresApproval: form.get("requiresApproval") === "on",
          requiresLicense: form.get("requiresLicense") === "on",
          requiresResaleCert: form.get("requiresResaleCert") === "on",
          requiresPurchaseAgreement: form.get("requiresPurchaseAgreement") === "on",
          isActive: true,
          isFallback: form.get("isFallback") === "on",
          displayOrder: Number(form.get("displayOrder") || 0),
        },
        session.shop,
      );
      return { ok: true, message: "Tier created." };
    }
    if (intent === "reorder") {
      const ids = String(form.get("orderedIds") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await reorderTiers(prisma, shop.id, ids, session.shop);
      return { ok: true, message: "Display order updated (qualification unchanged)." };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Action failed" };
  }
  return { ok: false, message: "Unknown action" };
};

export default function TiersPage() {
  const { tiers, currencyCode } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Pricing Tiers">
      <s-button slot="primary-action" href="/app/tiers/new">
        New tier
      </s-button>

      {actionData?.message ? (
        <FlashBanner message={actionData.message} ok={actionData.ok} />
      ) : null}

      <PageIntro>
        Thresholds use {currencyCode}. Ranges are half-open: each tier runs up to, but does not
        include, the next minimum. Renaming keeps the same internal ID.
      </PageIntro>

      <s-section heading="Your tiers">
        {tiers.length === 0 ? (
          <EmptyState
            title="No tiers configured"
            body="Create your own names and thresholds, or apply the optional HVAC starter preset as a starting point."
          >
            <Form method="post">
              <input type="hidden" name="intent" value="preset" />
              <s-button type="submit">Apply optional starter preset</s-button>
            </Form>
          </EmptyState>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Name</s-table-header>
              <s-table-header>Spend range</s-table-header>
              <s-table-header>Discount</s-table-header>
              <s-table-header>Approval</s-table-header>
              <s-table-header>Customers</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {tiers.map((t) => (
                <s-table-row key={t.id}>
                  <s-table-cell>
                    <TierName
                      name={t.name}
                      badgeColor={t.badgeColor}
                      fallback={t.isFallback}
                    />
                  </s-table-cell>
                  <s-table-cell>{t.rangeLabel}</s-table-cell>
                  <s-table-cell>{t.discount}%</s-table-cell>
                  <s-table-cell>{t.requiresApproval ? "Required" : "—"}</s-table-cell>
                  <s-table-cell>{t.assigned}</s-table-cell>
                  <s-table-cell>{t.isActive ? "Active" : "Inactive"}</s-table-cell>
                  <s-table-cell>
                    <s-link href={`/app/tiers/${t.id}`}>Edit</s-link>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Quick create">
        <div className="vpm-panel">
          <Form method="post" className="vpm-form-stack">
            <input type="hidden" name="intent" value="create" />
            <s-stack direction="block" gap="base">
              <s-text-field name="name" label="Tier name" required />
              <s-text-field
                name="minSpend"
                label={`Min spend (${currencyCode})`}
                defaultValue="0"
              />
              <s-text-field name="discountPercent" label="Discount %" defaultValue="0" />
              <s-button type="submit">Create tier</s-button>
            </s-stack>
          </Form>
          <s-paragraph>
            Need more options?{" "}
            <s-link href="/app/tiers/new">Open the full tier editor</s-link>.
          </s-paragraph>
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
