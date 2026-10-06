import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { useEffect, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import {
  applyStarterPreset,
  archiveTier,
  createTier,
  listTiers,
  updateTier,
} from "../services/tiers/tier-service";
import { buildSpendRanges } from "../lib/policies";
import { formatMoney, bpsToPercentString, fromMinorUnits } from "../lib/money";
import {
  Check,
  EmptyState,
  Field,
  FlashBanner,
  PageIntro,
  SubmitButton,
  TextArea,
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
        minSpend: fromMinorUnits(t.minSpendMinor),
        minSpendLabel: formatMoney(t.minSpendMinor, shop.currencyCode),
        rangeLabel:
          range?.maxSpendMinorExclusive == null
            ? `${formatMoney(t.minSpendMinor, shop.currencyCode)}+`
            : `${formatMoney(t.minSpendMinor, shop.currencyCode)} – under ${formatMoney(range.maxSpendMinorExclusive, shop.currencyCode)}`,
        requiresApproval: t.requiresApproval,
        requiresLicense: t.requiresLicense,
        requiresResaleCert: t.requiresResaleCert,
        requiresPurchaseAgreement: t.requiresPurchaseAgreement,
        allowProjectedVolume: t.allowProjectedVolume,
        minPurchaseHistoryMonths: t.minPurchaseHistoryMonths,
        displayOrder: t.displayOrder,
        isActive: t.isActive,
        isFallback: t.isFallback,
        assigned: t._count.assignments,
      };
    }),
  };
};

function readTierFields(form: FormData) {
  return {
    name: String(form.get("name") || "").trim(),
    description: String(form.get("description") || ""),
    badgeColor: String(form.get("badgeColor") || "#5C6AC4"),
    minSpend: String(form.get("minSpend") || "0").replace(/[^0-9.]/g, "") || "0",
    discountPercent: Number(String(form.get("discountPercent") || "0").replace(/[^0-9.]/g, "") || 0),
    requiresApproval: form.get("requiresApproval") === "on",
    requiresLicense: form.get("requiresLicense") === "on",
    requiresResaleCert: form.get("requiresResaleCert") === "on",
    requiresPurchaseAgreement: form.get("requiresPurchaseAgreement") === "on",
    minPurchaseHistoryMonths: form.get("minPurchaseHistoryMonths")
      ? Number(form.get("minPurchaseHistoryMonths"))
      : null,
    allowProjectedVolume: form.get("allowProjectedVolume") === "on",
    isActive: form.get("isActive") === "on",
    isFallback: form.get("isFallback") === "on",
    displayOrder: Number(form.get("displayOrder") || 0),
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    if (intent === "preset") {
      await applyStarterPreset(prisma, shop.id, session.shop);
      return { ok: true, message: "Starter preset applied.", closeEditor: true };
    }
    if (intent === "create") {
      const fields = readTierFields(form);
      if (!fields.name) return { ok: false, message: "Tier name is required." };
      await createTier(prisma, shop.id, fields, session.shop);
      return { ok: true, message: "Tier created.", closeEditor: true };
    }
    if (intent === "update") {
      const tierId = String(form.get("tierId") || "");
      if (!tierId) return { ok: false, message: "Missing tier." };
      const fields = readTierFields(form);
      if (!fields.name) return { ok: false, message: "Tier name is required." };
      await updateTier(prisma, shop.id, tierId, fields, session.shop);
      return { ok: true, message: "Tier saved.", closeEditor: true };
    }
    if (intent === "archive") {
      const tierId = String(form.get("tierId") || "");
      if (!tierId) return { ok: false, message: "Missing tier." };
      await archiveTier(prisma, shop.id, tierId, session.shop, {
        useFallback: true,
        reassignToTierId: null,
      });
      return { ok: true, message: "Tier archived.", closeEditor: true };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Action failed" };
  }
  return { ok: false, message: "Unknown action" };
};

type TierRow = ReturnType<typeof useLoaderData<typeof loader>>["tiers"][number];

function TierEditorForm({
  tier,
  currencyCode,
  busy,
  onCancel,
}: {
  tier?: TierRow | null;
  currencyCode: string;
  busy: boolean;
  onCancel: () => void;
}) {
  const isCreate = !tier;
  return (
    <div className="vpm-panel vpm-tier-editor">
      <h3 className="vpm-tier-editor-title">{isCreate ? "New tier" : `Edit ${tier.name}`}</h3>
      <Form method="post" className="vpm-form-stack">
        <input type="hidden" name="intent" value={isCreate ? "create" : "update"} />
        {!isCreate ? <input type="hidden" name="tierId" value={tier.id} /> : null}
        <div className="vpm-tier-editor-grid">
          <Field label="Name" name="name" defaultValue={tier?.name ?? ""} required />
          <Field
            label={`Min spend (${currencyCode})`}
            name="minSpend"
            inputMode="decimal"
            defaultValue={tier?.minSpend ?? "0"}
            required
          />
          <Field
            label="Discount %"
            name="discountPercent"
            inputMode="decimal"
            defaultValue={tier?.discount ?? "0"}
            required
          />
          <Field
            label="Badge color"
            name="badgeColor"
            type="color"
            defaultValue={tier?.badgeColor ?? "#5C6AC4"}
          />
          <Field
            label="Display order"
            name="displayOrder"
            type="number"
            defaultValue={String(tier?.displayOrder ?? 0)}
          />
        </div>
        <TextArea label="Description" name="description" defaultValue={tier?.description ?? ""} />
        <div className="vpm-tier-checks">
          <Check label="Requires business approval" name="requiresApproval" defaultChecked={tier?.requiresApproval} />
          <Check label="Requires license" name="requiresLicense" defaultChecked={tier?.requiresLicense} />
          <Check label="Requires resale cert" name="requiresResaleCert" defaultChecked={tier?.requiresResaleCert} />
          <Check
            label="Requires purchase agreement"
            name="requiresPurchaseAgreement"
            defaultChecked={tier?.requiresPurchaseAgreement}
          />
          <Check
            label="Allow projected-volume assignment"
            name="allowProjectedVolume"
            defaultChecked={tier?.allowProjectedVolume}
          />
          <Check label="Active" name="isActive" defaultChecked={tier?.isActive ?? true} />
          <Check label="Fallback tier" name="isFallback" defaultChecked={tier?.isFallback} />
        </div>
        <div className="vpm-actions">
          <SubmitButton disabled={busy}>{busy ? "Saving…" : isCreate ? "Create tier" : "Save changes"}</SubmitButton>
          <button type="button" className="vpm-btn vpm-btn--secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </Form>
      {!isCreate ? (
        <Form
          method="post"
          className="vpm-tier-archive"
          onSubmit={(e) => {
            if (!confirm(`Archive “${tier.name}”? Customers on this tier will move to the fallback tier.`)) {
              e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="intent" value="archive" />
          <input type="hidden" name="tierId" value={tier.id} />
          <SubmitButton variant="critical" disabled={busy}>
            Archive tier
          </SubmitButton>
        </Form>
      ) : null}
    </div>
  );
}

export default function TiersPage() {
  const { tiers, currencyCode } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (actionData && "closeEditor" in actionData && actionData.closeEditor && actionData.ok) {
      setEditingId(null);
      setCreating(false);
    }
  }, [actionData]);

  const editingTier = editingId ? tiers.find((t) => t.id === editingId) : null;

  return (
    <s-page heading="Pricing Tiers">
      <div slot="primary-action">
        <button
          type="button"
          className="vpm-btn"
          onClick={() => {
            setCreating(true);
            setEditingId(null);
          }}
        >
          New tier
        </button>
      </div>

      {actionData?.message ? (
        <FlashBanner message={actionData.message} ok={actionData.ok} />
      ) : null}

      <PageIntro>
        Manage all tiers here — edit opens on this page (no separate screen). Spend ranges use{" "}
        {currencyCode}; each tier runs up to (but not including) the next minimum.
      </PageIntro>

      {creating ? (
        <s-section heading="Create tier">
          <TierEditorForm
            currencyCode={currencyCode}
            busy={busy}
            onCancel={() => setCreating(false)}
          />
        </s-section>
      ) : null}

      {editingTier ? (
        <s-section heading="Edit tier">
          <TierEditorForm
            key={editingTier.id}
            tier={editingTier}
            currencyCode={currencyCode}
            busy={busy}
            onCancel={() => setEditingId(null)}
          />
        </s-section>
      ) : null}

      <s-section heading="Your tiers">
        {tiers.length === 0 && !creating ? (
          <EmptyState
            title="No tiers configured"
            body="Create your own names and thresholds, or apply the optional HVAC starter preset."
          >
            <Form method="post">
              <input type="hidden" name="intent" value="preset" />
              <SubmitButton>Apply starter preset</SubmitButton>
            </Form>
            <button type="button" className="vpm-btn vpm-btn--secondary" onClick={() => setCreating(true)}>
              Create tier
            </button>
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
                  <tr key={t.id} className={editingId === t.id ? "vpm-table-row--active" : undefined}>
                    <td>
                      <TierName name={t.name} badgeColor={t.badgeColor} fallback={t.isFallback} />
                    </td>
                    <td>{t.rangeLabel}</td>
                    <td>{t.discount}%</td>
                    <td>{t.requiresApproval ? "Required" : "—"}</td>
                    <td>{t.assigned}</td>
                    <td>{t.isActive ? "Active" : "Inactive"}</td>
                    <td>
                      <button
                        type="button"
                        className="vpm-linkish"
                        onClick={() => {
                          setCreating(false);
                          setEditingId(t.id);
                        }}
                      >
                        Edit
                      </button>
                    </td>
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
