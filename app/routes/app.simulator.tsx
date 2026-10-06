import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  ensureShop,
  parseAutomationPolicy,
  parseSpendPolicy,
} from "../services/shop/shop-service";
import { qualifyCustomer, type TierRecord } from "../services/eligibility/tier-engine";
import { decideAssignment } from "../services/assignment/decide-assignment";
import { toMinorUnits, formatMoney, bpsToPercentString } from "../lib/money";
import { PageIntro } from "../components/admin/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const tiers = await prisma.pricingTier.findMany({
    where: { shopId: shop.id, isArchived: false },
  });
  return {
    currencyCode: shop.currencyCode,
    tierCount: tiers.length,
    hasTiers: tiers.length > 0,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const form = await request.formData();
  const spend = String(form.get("spend") || "0");
  const previewOnly = form.get("previewCustomers") === "on";

  const tiers = (await prisma.pricingTier.findMany({
    where: { shopId: shop.id, isArchived: false },
  })) as unknown as TierRecord[];

  const flags = {
    businessApproved: form.get("businessApproved") === "on",
    licenseVerified: form.get("licenseVerified") === "on",
    resaleCertVerified: form.get("resaleCertVerified") === "on",
    purchaseAgreementVerified: form.get("purchaseAgreementVerified") === "on",
    projectedVolumeApproved: form.get("projectedVolumeApproved") === "on",
    firstOrderAt: form.get("firstOrderAt") ? new Date(String(form.get("firstOrderAt"))) : null,
    now: new Date(),
  };

  const spendMinor = toMinorUnits(spend);
  const qualification = qualifyCustomer(spendMinor, tiers, flags);
  const decision = decideAssignment({
    spendMinor,
    tiers,
    flags,
    current: {
      calculatedTierId: null,
      effectiveTierId: null,
      pendingTierId: null,
      overrideTierId: null,
      overrideExpiresAt: null,
      overridePausesAutomation: false,
      gracePeriodEndsAt: null,
      nextReviewAt: null,
      historyStatus: "COMPLETE",
      protectFromIncompleteHistoryDowngrade: parseSpendPolicy(shop.spendPolicy)
        .protectFromIncompleteHistoryDowngrade,
    },
    policy: parseAutomationPolicy(shop.automationPolicy),
    now: flags.now,
  });

  let customerPreview: Array<{ id: string; name: string; current: string; wouldBe: string }> = [];
  if (previewOnly) {
    // Dry-run against stored customers using THIS simulated eligibility/spend only as illustration
    // of config — does not mutate assignments.
    const sample = await prisma.customerProfiles.findMany({
      where: { shopId: shop.id },
      take: 25,
      include: { effectiveTier: true },
    });
    customerPreview = sample.map((c) => {
      const q = qualifyCustomer(c.qualifyingSpendMinor, tiers, {
        ...flags,
        businessApproved: c.businessApproved,
        licenseVerified: c.licenseVerified,
        resaleCertVerified: c.resaleCertVerified,
        purchaseAgreementVerified: c.purchaseAgreementVerified,
        projectedVolumeApproved: c.projectedVolumeApproved,
        firstOrderAt: c.firstOrderAt,
      });
      return {
        id: c.id,
        name: c.displayName || c.email || c.shopifyCustomerId,
        current: c.effectiveTier?.name ?? "—",
        wouldBe: q.calculatedTier?.name ?? "—",
      };
    });
  }

  return {
    ok: true,
    spendFormatted: formatMoney(spendMinor, shop.currencyCode),
    calculated: qualification.calculatedTier?.name ?? "None",
    calculatedDiscount: qualification.calculatedTier
      ? `${bpsToPercentString(qualification.calculatedTier.discountBps)}%`
      : "—",
    effective: decision.effectiveTierId
      ? tiers.find((t) => t.id === decision.effectiveTierId)?.name ?? decision.effectiveTierId
      : "None",
    reason: decision.reason,
    deferred: decision.deferred,
    nextTier: qualification.nextEligibleTier?.name ?? null,
    spendNeeded: qualification.nextEligibleTier
      ? formatMoney(qualification.spendNeededMinor, shop.currencyCode)
      : null,
    evaluated: qualification.evaluatedTiers,
    blockingReasons: qualification.blockingReasons,
    customerPreview,
  };
};

export default function SimulatorPage() {
  const { currencyCode, hasTiers } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();

  return (
    <s-page heading="Simulator">
      <PageIntro>
        Enter example spend and eligibility flags. Nothing here changes live assignments — use customer
        tools for approvals and overrides. Currency: {currencyCode}.
      </PageIntro>

      <s-section heading="Preview assignment">
        {!hasTiers ? (
          <s-banner tone="info">
            Create at least one tier before simulating.{" "}
            <s-link href="/app/tiers">Pricing Tiers</s-link>
          </s-banner>
        ) : null}
        <div className="vpm-panel">
        <Form method="post">
          <s-stack direction="block" gap="base">
            <s-text-field name="spend" label={`Example qualifying spend (${currencyCode})`} defaultValue="2500" />
            <s-text-field name="firstOrderAt" label="First order date (optional ISO)" />
            <label>
              <input type="checkbox" name="businessApproved" /> Business approved
            </label>
            <label>
              <input type="checkbox" name="licenseVerified" /> License verified
            </label>
            <label>
              <input type="checkbox" name="resaleCertVerified" /> Resale certificate verified
            </label>
            <label>
              <input type="checkbox" name="purchaseAgreementVerified" /> Purchase agreement verified
            </label>
            <label>
              <input type="checkbox" name="projectedVolumeApproved" /> Projected volume approved
            </label>
            <label>
              <input type="checkbox" name="previewCustomers" /> Also preview against stored customers
              (read-only)
            </label>
            <s-button type="submit">Simulate</s-button>
          </s-stack>
        </Form>
        </div>
      </s-section>

      {result?.ok ? (
        <s-section heading="Result">
          <div className="vpm-panel vpm-panel--subdued">
          <s-paragraph>
            Spend {result.spendFormatted} → calculated <strong>{result.calculated}</strong> (
            {result.calculatedDiscount}), effective <strong>{result.effective}</strong>
          </s-paragraph>
          <s-paragraph>{result.reason}{result.deferred ? " (deferred)" : ""}</s-paragraph>
          {result.nextTier ? (
            <s-paragraph>
              Next tier {result.nextTier} needs {result.spendNeeded} more qualifying spend.
            </s-paragraph>
          ) : null}
          {result.blockingReasons.length ? (
            <s-paragraph>Blocking: {result.blockingReasons.join("; ")}</s-paragraph>
          ) : null}
          <s-unordered-list>
            {result.evaluated.map((e) => (
              <s-list-item key={e.tierId}>
                {e.tierName}: spend {e.spendOk ? "ok" : "no"}, eligibility{" "}
                {e.eligibilityOk ? "ok" : "no"}
                {e.reasons.length ? ` — ${e.reasons.join(", ")}` : ""}
              </s-list-item>
            ))}
          </s-unordered-list>
          {result.customerPreview.length ? (
            <>
              <s-heading>Stored customer preview (not applied)</s-heading>
              <s-unordered-list>
                {result.customerPreview.map((c) => (
                  <s-list-item key={c.id}>
                    {c.name}: current {c.current} → would calculate {c.wouldBe}
                  </s-list-item>
                ))}
              </s-unordered-list>
            </>
          ) : null}
          </div>
        </s-section>
      ) : null}
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
