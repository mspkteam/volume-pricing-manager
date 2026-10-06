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
import {
  AdminLink,
  EmptyState,
  Field,
  FlashBanner,
  PageIntro,
  SubmitButton,
  TierName,
} from "../components/admin/ui";

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
      const name = String(form.get("name") || "").trim();
      if (!name) return { ok: false, message: "Tier name is required." };
      await createTier(
        prisma,
        shop.id,
        {
          name,
          description: "",
          badgeColor: "#5C6AC4",
          minSpend: String(form.get("minSpend") || "0").replace(/[^0-9.]/g, "") || "0",
          discountPercent: Number(
            String(form.get("discountPercent") || "0").replace(/[^0-9.]/g, "") || 0,
          ),
          requiresApproval: false,
          requiresLicense: false,
          requiresResaleCert: false,
          requiresPurchaseAgreement: false,
          isActive: true,
          isFallback: false,
          displayOrder: 0,
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
      <div slot="primary-action">
        <AdminLink to="/app/tiers/new" className="vpm-btn">
          New tier
        </AdminLink>
      </div>

      {actionData?.message ? (
        <FlashBanner message={actionData.message} ok={actionData.ok} />
      ) : null}

      <PageIntro>
        Each tier starts at its minimum spend in {currencyCode} and runs up to (but not including)
        the next tier&apos;s minimum. Click Edit to change a tier.
      </PageIntro>

      <s-section heading="Your tiers">
        {tiers.length === 0 ? (
          <EmptyState
            title="No tiers configured"
            body="Create your own names and thresholds, or apply the optional HVAC starter preset."
          >
            <Form method="post">
              <input type="hidden" name="intent" value="preset" />
              <SubmitButton>Apply starter preset</SubmitButton>
            </Form>
            <AdminLink to="/app/tiers/new" className="vpm-btn vpm-btn--secondary">
              Create tier
            </AdminLink>
          </EmptyState>
        ) : (
          <div className="vpm-panel" style={{ padding: 0, overflow: "auto" }}>
            <table className="vpm-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Spend range</th>
                  <th>Discount</th>
                  <th>Approval</th>
                  <th>Customers</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tiers.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <TierName
                        name={t.name}
                        badgeColor={t.badgeColor}
                        fallback={t.isFallback}
                      />
                    </td>
                    <td>{t.rangeLabel}</td>
                    <td>{t.discount}%</td>
                    <td>{t.requiresApproval ? "Required" : "—"}</td>
                    <td>{t.assigned}</td>
                    <td>{t.isActive ? "Active" : "Inactive"}</td>
                    <td>
                      <AdminLink to={`/app/tiers/${t.id}`}>Edit</AdminLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-section>

      <s-section heading="Quick create">
        <div className="vpm-panel">
          <Form method="post" className="vpm-form-stack">
            <input type="hidden" name="intent" value="create" />
            <Field label="Tier name" name="name" required placeholder="e.g. Tier B" />
            <Field
              label={`Min spend (${currencyCode})`}
              name="minSpend"
              inputMode="decimal"
              defaultValue="0"
            />
            <Field
              label="Discount %"
              name="discountPercent"
              inputMode="decimal"
              defaultValue="0"
            />
            <div className="vpm-actions">
              <SubmitButton>Create tier</SubmitButton>
              <AdminLink to="/app/tiers/new" className="vpm-btn vpm-btn--secondary">
                Full editor
              </AdminLink>
            </div>
          </Form>
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
