import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
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
import { buildSpendRanges } from "../lib/policies";
import {
  AdminLink,
  Check,
  Field,
  FlashBanner,
  PageIntro,
  SelectField,
  StatCard,
  StatGrid,
  SubmitButton,
} from "../components/admin/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const tiers = await prisma.pricingTier.findMany({
    where: { shopId: shop.id, isArchived: false },
    orderBy: { displayOrder: "asc" },
  });
  const spendPolicy = parseSpendPolicy(shop.spendPolicy);
  const automationPolicy = parseAutomationPolicy(shop.automationPolicy);
  const ranges = buildSpendRanges(tiers);

  return {
    currencyCode: shop.currencyCode,
    automationPaused: shop.automationPaused,
    hasTiers: tiers.length > 0,
    tiers: tiers.map((t) => ({
      id: t.id,
      name: t.name,
      minSpend: formatMoney(t.minSpendMinor, shop.currencyCode),
      discount: `${bpsToPercentString(t.discountBps)}%`,
      requiresApproval: t.requiresApproval,
      requiresLicense: t.requiresLicense,
      isActive: t.isActive,
      isFallback: t.isFallback,
    })),
    ranges: ranges.map((r) => ({
      id: r.id,
      name: r.name,
      min: formatMoney(r.minSpendMinor, shop.currencyCode),
      max: r.maxSpendMinorExclusive
        ? formatMoney(r.maxSpendMinorExclusive, shop.currencyCode)
        : "∞",
      discount: `${bpsToPercentString(r.discountBps)}%`,
    })),
    policySummary: {
      rollingMonths: spendPolicy.rollingPeriodMonths,
      upgradeMode: automationPolicy.upgradeMode,
      downgradeMode: automationPolicy.downgradeMode,
      gracePeriodDays: automationPolicy.gracePeriodDays,
      protectIncomplete: spendPolicy.protectFromIncompleteHistoryDowngrade,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const form = await request.formData();
  const spend = String(form.get("spend") || "0");
  const previewOnly = form.get("previewCustomers") === "on";
  const historyStatus = String(form.get("historyStatus") || "COMPLETE") as
    | "COMPLETE"
    | "INSUFFICIENT"
    | "PARTIAL"
    | "UNKNOWN";

  const tiers = (await prisma.pricingTier.findMany({
    where: { shopId: shop.id, isArchived: false },
  })) as unknown as TierRecord[];

  if (!tiers.length) {
    return { ok: false, message: "Create at least one tier before simulating." };
  }

  const spendPolicy = parseSpendPolicy(shop.spendPolicy);
  const automationPolicy = parseAutomationPolicy(shop.automationPolicy);
  if (shop.automationPaused) {
    automationPolicy.pauseAutomation = true;
  }

  const flags = {
    businessApproved: form.get("businessApproved") === "on",
    licenseVerified: form.get("licenseVerified") === "on",
    resaleCertVerified: form.get("resaleCertVerified") === "on",
    purchaseAgreementVerified: form.get("purchaseAgreementVerified") === "on",
    projectedVolumeApproved: form.get("projectedVolumeApproved") === "on",
    firstOrderAt: form.get("firstOrderAt") ? new Date(String(form.get("firstOrderAt"))) : null,
    now: new Date(),
  };

  let spendMinor: bigint;
  try {
    spendMinor = toMinorUnits(spend);
  } catch {
    return { ok: false, message: "Enter a valid spend amount in major units (e.g. 2500)." };
  }

  const currentEffectiveId = String(form.get("currentEffectiveTierId") || "") || null;
  const qualification = qualifyCustomer(spendMinor, tiers, flags);
  const decision = decideAssignment({
    spendMinor,
    tiers,
    flags,
    current: {
      calculatedTierId: currentEffectiveId,
      effectiveTierId: currentEffectiveId,
      pendingTierId: null,
      overrideTierId: null,
      overrideExpiresAt: null,
      overridePausesAutomation: false,
      gracePeriodEndsAt: null,
      nextReviewAt: null,
      historyStatus,
      protectFromIncompleteHistoryDowngrade: spendPolicy.protectFromIncompleteHistoryDowngrade,
    },
    policy: automationPolicy,
    now: flags.now,
  });

  let customerPreview: Array<{
    id: string;
    name: string;
    spend: string;
    current: string;
    wouldBe: string;
  }> = [];
  if (previewOnly) {
    const sample = await prisma.customerProfiles.findMany({
      where: { shopId: shop.id },
      take: 25,
      include: { effectiveTier: true },
      orderBy: { qualifyingSpendMinor: "desc" },
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
        spend: formatMoney(c.qualifyingSpendMinor, shop.currencyCode),
        current: c.effectiveTier?.name ?? "—",
        wouldBe: q.calculatedTier?.name ?? "—",
      };
    });
  }

  return {
    ok: true,
    message: undefined as string | undefined,
    spendFormatted: formatMoney(spendMinor, shop.currencyCode),
    calculated: qualification.calculatedTier?.name ?? "None",
    calculatedDiscount: qualification.calculatedTier
      ? `${bpsToPercentString(qualification.calculatedTier.discountBps)}%`
      : "—",
    effective: decision.effectiveTierId
      ? tiers.find((t) => t.id === decision.effectiveTierId)?.name ?? decision.effectiveTierId
      : "None",
    changeType: decision.changeType,
    reason: decision.reason,
    deferred: decision.deferred,
    nextTier: qualification.nextEligibleTier?.name ?? null,
    spendNeeded: qualification.nextEligibleTier
      ? formatMoney(qualification.spendNeededMinor, shop.currencyCode)
      : null,
    evaluated: qualification.evaluatedTiers,
    blockingReasons: qualification.blockingReasons,
    customerPreview,
    automationPaused: shop.automationPaused,
  };
};

export default function SimulatorPage() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <s-page heading="Simulator">
      {result && "message" in result && result.message && !result.ok ? (
        <FlashBanner message={result.message} ok={false} />
      ) : null}

      <PageIntro>
        Dry-run the same qualification + assignment engine used in automation. Nothing here changes live
        customers. Currency: {data.currencyCode}.{" "}
        <AdminLink to="/app/automation">Edit automation policies</AdminLink>
      </PageIntro>

      {data.automationPaused ? (
        <s-banner tone="warning" heading="Automation is paused">
          Simulations still show calculated tiers, but effective assignment will report as deferred —
          matching production behavior while paused.
        </s-banner>
      ) : null}

      <StatGrid>
        <StatCard label="Rolling window" value={`${data.policySummary.rollingMonths} mo`} />
        <StatCard label="Upgrades" value={data.policySummary.upgradeMode.replace("_", " ")} />
        <StatCard
          label="Downgrades"
          value={data.policySummary.downgradeMode.replace("_", " ")}
          hint={
            data.policySummary.downgradeMode === "grace_period"
              ? `${data.policySummary.gracePeriodDays} day grace`
              : undefined
          }
        />
        <StatCard
          label="Incomplete history"
          value={data.policySummary.protectIncomplete ? "Protected" : "Allow downgrade"}
        />
      </StatGrid>

      <s-section heading="Active tier ladder">
        {!data.hasTiers ? (
          <s-banner tone="info">
            Create at least one tier before simulating.{" "}
            <AdminLink to="/app/tiers">Pricing tiers</AdminLink>
          </s-banner>
        ) : (
          <div className="vpm-panel" style={{ padding: 0, overflow: "auto" }}>
            <table className="vpm-table">
              <thead>
                <tr>
                  <th>Tier</th>
                  <th>Spend range</th>
                  <th>Discount</th>
                  <th>Requirements</th>
                </tr>
              </thead>
              <tbody>
                {data.tiers
                  .filter((t) => t.isActive)
                  .map((t) => {
                    const range = data.ranges.find((r) => r.id === t.id);
                    return (
                      <tr key={t.id}>
                        <td>
                          <strong>{t.name}</strong>
                          {t.isFallback ? " · fallback" : ""}
                        </td>
                        <td>
                          {range ? `${range.min} – ${range.max}` : t.minSpend}+
                        </td>
                        <td>{t.discount}</td>
                        <td>
                          {[
                            t.requiresApproval ? "approval" : null,
                            t.requiresLicense ? "license" : null,
                          ]
                            .filter(Boolean)
                            .join(", ") || "—"}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </s-section>

      <s-section heading="Preview assignment">
        <div className="vpm-panel">
          <Form method="post" className="vpm-form-stack">
            <Field
              label={`Example qualifying spend (${data.currencyCode})`}
              name="spend"
              defaultValue="2500"
              required
            />
            <SelectField
              label="Assume current effective tier (for upgrade/downgrade)"
              name="currentEffectiveTierId"
              defaultValue=""
            >
              <option value="">None (new customer)</option>
              {data.tiers
                .filter((t) => t.isActive)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </SelectField>
            <SelectField label="Order history status" name="historyStatus" defaultValue="COMPLETE">
              <option value="COMPLETE">Complete</option>
              <option value="PARTIAL">Partial</option>
              <option value="INSUFFICIENT">Insufficient</option>
              <option value="UNKNOWN">Unknown</option>
            </SelectField>
            <Field
              label="First order date (optional ISO, e.g. 2025-01-15)"
              name="firstOrderAt"
              placeholder="YYYY-MM-DD"
            />

            <s-heading>Eligibility flags</s-heading>
            <div className="vpm-check-grid">
              <Check label="Business approved" name="businessApproved" defaultChecked />
              <Check label="License verified" name="licenseVerified" />
              <Check label="Resale certificate verified" name="resaleCertVerified" />
              <Check label="Purchase agreement verified" name="purchaseAgreementVerified" />
              <Check label="Projected volume approved" name="projectedVolumeApproved" />
              <Check
                label="Also preview against stored customers (read-only)"
                name="previewCustomers"
              />
            </div>

            <SubmitButton disabled={busy || !data.hasTiers}>
              {busy ? "Simulating…" : "Simulate"}
            </SubmitButton>
          </Form>
        </div>
      </s-section>

      {result && result.ok === true ? (
        <s-section heading="Result">
          <StatGrid>
            <StatCard label="Spend" value={result.spendFormatted} />
            <StatCard
              label="Calculated tier"
              value={result.calculated}
              hint={result.calculatedDiscount}
            />
            <StatCard
              label="Effective tier"
              value={result.effective}
              hint={result.deferred ? "Deferred" : result.changeType || "Applied"}
            />
            <StatCard
              label="Next tier"
              value={result.nextTier || "—"}
              hint={result.spendNeeded ? `${result.spendNeeded} more needed` : undefined}
            />
          </StatGrid>

          <div className="vpm-panel vpm-panel--subdued" style={{ marginTop: "1rem" }}>
            <s-paragraph>
              <strong>Decision:</strong> {result.reason}
              {result.automationPaused ? " (automation paused on shop)" : ""}
            </s-paragraph>
            {(result.blockingReasons ?? []).length ? (
              <s-paragraph>
                <strong>Blocking:</strong> {(result.blockingReasons ?? []).join("; ")}
              </s-paragraph>
            ) : null}

            <table className="vpm-table" style={{ marginTop: "0.75rem" }}>
              <thead>
                <tr>
                  <th>Tier</th>
                  <th>Spend</th>
                  <th>Eligibility</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {(result.evaluated ?? []).map((e) => (
                  <tr key={e.tierId}>
                    <td>{e.tierName}</td>
                    <td>{e.spendOk ? "Pass" : "Fail"}</td>
                    <td>{e.eligibilityOk ? "Pass" : "Fail"}</td>
                    <td>{e.reasons.length ? e.reasons.join(", ") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(result.customerPreview ?? []).length ? (
            <div className="vpm-panel" style={{ marginTop: "1rem", padding: 0, overflow: "auto" }}>
              <div style={{ padding: "0.75rem 1rem" }}>
                <s-heading>Stored customer preview (not applied)</s-heading>
              </div>
              <table className="vpm-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Spend</th>
                    <th>Current</th>
                    <th>Would calculate</th>
                  </tr>
                </thead>
                <tbody>
                  {(result.customerPreview ?? []).map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td>{c.spend}</td>
                      <td>{c.current}</td>
                      <td>{c.wouldBe}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </s-section>
      ) : null}
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
