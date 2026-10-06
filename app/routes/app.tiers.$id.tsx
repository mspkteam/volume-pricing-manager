import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import {
  archiveTier,
  getArchiveImpact,
  updateTier,
  createTier,
} from "../services/tiers/tier-service";
import { bpsToPercentString, fromMinorUnits } from "../lib/money";
import { withEmbeddedSearch } from "../lib/embedded-nav";
import {
  AdminLink,
  Check,
  Field,
  FlashBanner,
  PageIntro,
  SelectField,
  SubmitButton,
  TextArea,
} from "../components/admin/ui";

function appRedirect(request: Request, path: string) {
  return redirect(withEmbeddedSearch(path, new URL(request.url).search));
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const id = params.id!;
  if (id === "new") {
    return { mode: "create" as const, currencyCode: shop.currencyCode, tier: null, impact: null, fallbacks: [] };
  }
  const tier = await prisma.pricingTier.findFirst({ where: { id, shopId: shop.id } });
  if (!tier) throw new Response("Not found", { status: 404 });
  const impact = await getArchiveImpact(prisma, shop.id, tier.id);
  const fallbacks = await prisma.pricingTier.findMany({
    where: { shopId: shop.id, isArchived: false, id: { not: tier.id } },
    select: { id: true, name: true, isFallback: true },
  });
  // Never spread Prisma rows — BigInt fields (minSpendMinor) break React Router serialization.
  return {
    mode: "edit" as const,
    currencyCode: shop.currencyCode,
    tier: {
      id: tier.id,
      name: tier.name,
      description: tier.description,
      badgeColor: tier.badgeColor,
      minSpend: fromMinorUnits(tier.minSpendMinor),
      discountPercent: bpsToPercentString(tier.discountBps),
      minPurchaseHistoryMonths: tier.minPurchaseHistoryMonths,
      displayOrder: tier.displayOrder,
      requiresApproval: tier.requiresApproval,
      requiresLicense: tier.requiresLicense,
      requiresResaleCert: tier.requiresResaleCert,
      requiresPurchaseAgreement: tier.requiresPurchaseAgreement,
      allowProjectedVolume: tier.allowProjectedVolume,
      isActive: tier.isActive,
      isFallback: tier.isFallback,
    },
    impact: { assignedCount: impact.assignedCount },
    fallbacks,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const id = params.id!;

  const readTierFields = () => ({
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
  });

  try {
    if (intent === "save" && id === "new") {
      const fields = readTierFields();
      if (!fields.name) return { ok: false, message: "Tier name is required." };
      const tier = await createTier(prisma, shop.id, fields, session.shop);
      return appRedirect(request, `/app/tiers/${tier.id}`);
    }
    if (intent === "save") {
      const fields = readTierFields();
      if (!fields.name) return { ok: false, message: "Tier name is required." };
      await updateTier(prisma, shop.id, id, fields, session.shop);
      return { ok: true, message: "Tier saved." };
    }
    if (intent === "archive") {
      await archiveTier(prisma, shop.id, id, session.shop, {
        useFallback: form.get("strategy") === "fallback",
        reassignToTierId:
          form.get("strategy") === "reassign" ? String(form.get("reassignToTierId")) : null,
      });
      return appRedirect(request, "/app/tiers");
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Save failed" };
  }
  return { ok: false, message: "Unknown action" };
};

export default function TierDetailPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = data.tier;

  return (
    <s-page heading={data.mode === "create" ? "Create tier" : `Edit ${t?.name}`}>
      <div slot="breadcrumb-actions">
        <AdminLink to="/app/tiers">← Back to tiers</AdminLink>
      </div>

      {actionData && "message" in actionData && actionData.message ? (
        <FlashBanner message={actionData.message} ok={actionData.ok} />
      ) : null}

      <PageIntro>
        Set the spend threshold and discount. Ranges recalculate from every tier&apos;s minimum —
        this tier covers up to (but not including) the next higher minimum.
      </PageIntro>

      <s-section heading="Tier details">
        <div className="vpm-panel">
          <Form method="post" className="vpm-form-stack">
            <input type="hidden" name="intent" value="save" />
            <Field label="Name" name="name" defaultValue={t?.name ?? ""} required />
            <TextArea label="Description" name="description" defaultValue={t?.description ?? ""} />
            <Field
              label="Badge color"
              name="badgeColor"
              type="color"
              defaultValue={t?.badgeColor ?? "#5C6AC4"}
            />
            <Field
              label={`Minimum qualifying spend (${data.currencyCode})`}
              name="minSpend"
              inputMode="decimal"
              defaultValue={t?.minSpend ?? "0"}
              required
            />
            <Field
              label="Discount percent"
              name="discountPercent"
              inputMode="decimal"
              defaultValue={t?.discountPercent ?? "0"}
              required
            />
            <Field
              label="Min purchase-history months (optional)"
              name="minPurchaseHistoryMonths"
              type="number"
              min={0}
              defaultValue={t?.minPurchaseHistoryMonths?.toString() ?? ""}
            />
            <Field
              label="Display order"
              name="displayOrder"
              type="number"
              defaultValue={String(t?.displayOrder ?? 0)}
            />
            <Check
              label="Requires business approval"
              name="requiresApproval"
              defaultChecked={t?.requiresApproval}
            />
            <Check
              label="Requires license / contractor ID"
              name="requiresLicense"
              defaultChecked={t?.requiresLicense}
            />
            <Check
              label="Requires resale certificate"
              name="requiresResaleCert"
              defaultChecked={t?.requiresResaleCert}
            />
            <Check
              label="Requires purchase agreement"
              name="requiresPurchaseAgreement"
              defaultChecked={t?.requiresPurchaseAgreement}
            />
            <Check
              label="Allow admin projected-volume assignment"
              name="allowProjectedVolume"
              defaultChecked={t?.allowProjectedVolume}
            />
            <Check label="Active" name="isActive" defaultChecked={t?.isActive ?? true} />
            <Check label="Fallback tier" name="isFallback" defaultChecked={t?.isFallback} />
            <div className="vpm-actions">
              <SubmitButton>{data.mode === "create" ? "Create tier" : "Save changes"}</SubmitButton>
              <AdminLink to="/app/tiers" className="vpm-btn vpm-btn--secondary">
                Cancel
              </AdminLink>
            </div>
          </Form>
        </div>
      </s-section>

      {data.mode === "edit" && data.impact ? (
        <s-section heading="Archive">
          <s-paragraph>
            {data.impact.assignedCount} customer(s) currently use this tier. Choose a reassignment
            strategy before archiving.
          </s-paragraph>
          <div className="vpm-panel">
            <Form method="post" className="vpm-form-stack">
              <input type="hidden" name="intent" value="archive" />
              <label className="vpm-check">
                <input type="radio" name="strategy" value="fallback" defaultChecked /> Reassign to
                fallback tier
              </label>
              <label className="vpm-check">
                <input type="radio" name="strategy" value="reassign" /> Reassign to specific tier
              </label>
              <SelectField label="Reassign to" name="reassignToTierId" defaultValue="">
                <option value="">—</option>
                {(data.fallbacks ?? []).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                    {f.isFallback ? " (fallback)" : ""}
                  </option>
                ))}
              </SelectField>
              <SubmitButton variant="critical">Archive tier</SubmitButton>
            </Form>
          </div>
        </s-section>
      ) : null}
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
