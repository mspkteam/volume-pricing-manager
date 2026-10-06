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

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const id = params.id!;
  if (id === "new") {
    return { mode: "create" as const, currencyCode: shop.currencyCode, tier: null, impact: null };
  }
  const tier = await prisma.pricingTier.findFirst({ where: { id, shopId: shop.id } });
  if (!tier) throw new Response("Not found", { status: 404 });
  const impact = await getArchiveImpact(prisma, shop.id, tier.id);
  const fallbacks = await prisma.pricingTier.findMany({
    where: { shopId: shop.id, isArchived: false, id: { not: tier.id } },
    select: { id: true, name: true, isFallback: true },
  });
  return {
    mode: "edit" as const,
    currencyCode: shop.currencyCode,
    tier: {
      ...tier,
      minSpend: fromMinorUnits(tier.minSpendMinor),
      discountPercent: bpsToPercentString(tier.discountBps),
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

  try {
    if (intent === "save" && id === "new") {
      const tier = await createTier(
        prisma,
        shop.id,
        {
          name: String(form.get("name")),
          description: String(form.get("description") || ""),
          badgeColor: String(form.get("badgeColor") || "#5C6AC4"),
          minSpend: String(form.get("minSpend") || "0"),
          discountPercent: Number(form.get("discountPercent") || 0),
          requiresApproval: form.get("requiresApproval") === "on",
          requiresLicense: form.get("requiresLicense") === "on",
          requiresResaleCert: form.get("requiresResaleCert") === "on",
          requiresPurchaseAgreement: form.get("requiresPurchaseAgreement") === "on",
          minPurchaseHistoryMonths: form.get("minPurchaseHistoryMonths")
            ? Number(form.get("minPurchaseHistoryMonths"))
            : null,
          allowProjectedVolume: form.get("allowProjectedVolume") === "on",
          isActive: form.get("isActive") !== "off",
          isFallback: form.get("isFallback") === "on",
          displayOrder: Number(form.get("displayOrder") || 0),
        },
        session.shop,
      );
      return redirect(`/app/tiers/${tier.id}`);
    }
    if (intent === "save") {
      await updateTier(
        prisma,
        shop.id,
        id,
        {
          name: String(form.get("name")),
          description: String(form.get("description") || ""),
          badgeColor: String(form.get("badgeColor") || "#5C6AC4"),
          minSpend: String(form.get("minSpend") || "0"),
          discountPercent: Number(form.get("discountPercent") || 0),
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
        },
        session.shop,
      );
      return { ok: true, message: "Tier saved. Assignments keep the same tier ID after rename." };
    }
    if (intent === "archive") {
      await archiveTier(prisma, shop.id, id, session.shop, {
        useFallback: form.get("strategy") === "fallback",
        reassignToTierId:
          form.get("strategy") === "reassign" ? String(form.get("reassignToTierId")) : null,
      });
      return redirect("/app/tiers");
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
      <s-link slot="breadcrumb-actions" href="/app/tiers">
        Back to tiers
      </s-link>
      {actionData && "message" in actionData && actionData.message ? (
        <s-banner tone={actionData.ok ? "success" : "critical"}>{actionData.message}</s-banner>
      ) : null}

      <s-section heading="Tier details">
        <Form method="post">
          <input type="hidden" name="intent" value="save" />
          <s-stack direction="block" gap="base">
            <s-text-field name="name" label="Name" defaultValue={t?.name ?? ""} required />
            <s-text-field name="description" label="Description" defaultValue={t?.description ?? ""} />
            <s-text-field name="badgeColor" label="Badge color" defaultValue={t?.badgeColor ?? "#5C6AC4"} />
            <s-text-field
              name="minSpend"
              label={`Minimum qualifying spend (${data.currencyCode})`}
              defaultValue={t?.minSpend ?? "0"}
            />
            <s-text-field
              name="discountPercent"
              label="Discount percent"
              defaultValue={t?.discountPercent ?? "0"}
            />
            <s-text-field
              name="minPurchaseHistoryMonths"
              label="Min purchase-history months (optional)"
              defaultValue={t?.minPurchaseHistoryMonths?.toString() ?? ""}
            />
            <s-text-field
              name="displayOrder"
              label="Display order"
              defaultValue={String(t?.displayOrder ?? 0)}
            />
            <label>
              <input type="checkbox" name="requiresApproval" defaultChecked={t?.requiresApproval} />{" "}
              Requires business approval
            </label>
            <label>
              <input type="checkbox" name="requiresLicense" defaultChecked={t?.requiresLicense} />{" "}
              Requires license / contractor ID
            </label>
            <label>
              <input
                type="checkbox"
                name="requiresResaleCert"
                defaultChecked={t?.requiresResaleCert}
              />{" "}
              Requires resale certificate
            </label>
            <label>
              <input
                type="checkbox"
                name="requiresPurchaseAgreement"
                defaultChecked={t?.requiresPurchaseAgreement}
              />{" "}
              Requires purchase agreement
            </label>
            <label>
              <input
                type="checkbox"
                name="allowProjectedVolume"
                defaultChecked={t?.allowProjectedVolume}
              />{" "}
              Allow admin projected-volume assignment
            </label>
            <label>
              <input type="checkbox" name="isActive" defaultChecked={t?.isActive ?? true} /> Active
            </label>
            <label>
              <input type="checkbox" name="isFallback" defaultChecked={t?.isFallback} /> Fallback
              tier
            </label>
            <s-button type="submit">Save</s-button>
          </s-stack>
        </Form>
      </s-section>

      {data.mode === "edit" && data.impact ? (
        <s-section heading="Archive">
          <s-paragraph>
            {data.impact.assignedCount} customer(s) currently use this tier. Choose a reassignment
            strategy before archiving.
          </s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value="archive" />
            <s-stack direction="block" gap="base">
              <label>
                <input type="radio" name="strategy" value="fallback" defaultChecked /> Reassign to
                fallback tier
              </label>
              <label>
                <input type="radio" name="strategy" value="reassign" /> Reassign to specific tier
              </label>
              <select name="reassignToTierId">
                {(data.fallbacks ?? []).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                    {f.isFallback ? " (fallback)" : ""}
                  </option>
                ))}
              </select>
              <s-button type="submit" tone="critical" disabled={data.impact.assignedCount > 0 && false}>
                Archive tier
              </s-button>
            </s-stack>
          </Form>
        </s-section>
      ) : null}
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
