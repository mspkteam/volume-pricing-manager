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
import { enqueueJob, JOB_TYPES } from "../services/jobs/queue";
import { writeAuditLog } from "../services/audit/audit-log";
import { recalculateShopCustomers } from "../services/assignment/recalculate";
import type { AutomationPolicy, SpendPolicy } from "../lib/policies";
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
import { formatDateTime } from "../lib/format";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const spendPolicy = parseSpendPolicy(shop.spendPolicy);
  const automationPolicy = parseAutomationPolicy(shop.automationPolicy);
  const [jobs, customerCount, tierCount, pendingReviews] = await Promise.all([
    prisma.backgroundJobs.findMany({
      where: { shopDomain: session.shop },
      orderBy: { updatedAt: "desc" },
      take: 15,
    }),
    prisma.customerProfiles.count({ where: { shopId: shop.id } }),
    prisma.pricingTier.count({ where: { shopId: shop.id, isArchived: false, isActive: true } }),
    prisma.customerProfiles.count({
      where: { shopId: shop.id, pendingTierId: { not: null } },
    }),
  ]);
  const failed = jobs.filter((j) => j.status === "FAILED" || j.status === "DEAD");

  return {
    spendPolicy,
    automationPolicy,
    automationPaused: shop.automationPaused,
    lastRecalculationAt: shop.lastRecalculationAt?.toISOString() ?? null,
    nextScheduledRunAt: shop.nextScheduledRunAt?.toISOString() ?? null,
    importStatus: shop.importStatus,
    importProgress: shop.importProgress,
    historyAccessLimited: shop.historyAccessLimited,
    historyCoverageMonths: shop.historyCoverageMonths,
    customerCount,
    tierCount,
    pendingReviews,
    jobs: jobs.map((j) => ({
      id: j.id,
      type: j.type,
      status: j.status,
      attempts: j.attempts,
      lastError: j.lastError,
      updatedAt: j.updatedAt.toISOString(),
    })),
    failedCount: failed.length,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    if (intent === "save_policies") {
      const spendPolicy: SpendPolicy = {
        ...parseSpendPolicy(shop.spendPolicy),
        rollingPeriodMonths: Math.min(
          36,
          Math.max(1, Number(form.get("rollingPeriodMonths") || 12)),
        ),
        includeTax: form.get("includeTax") === "on",
        includeShipping: form.get("includeShipping") === "on",
        excludeGiftCards: form.get("excludeGiftCards") === "on",
        excludeCancelled: form.get("excludeCancelled") === "on",
        excludeTestOrders: form.get("excludeTestOrders") === "on",
        protectFromIncompleteHistoryDowngrade:
          form.get("protectFromIncompleteHistoryDowngrade") === "on",
      };
      const automationPolicy: AutomationPolicy = {
        ...parseAutomationPolicy(shop.automationPolicy),
        upgradeMode: String(form.get("upgradeMode") || "immediate") as AutomationPolicy["upgradeMode"],
        downgradeMode: String(
          form.get("downgradeMode") || "grace_period",
        ) as AutomationPolicy["downgradeMode"],
        gracePeriodDays: Math.min(
          365,
          Math.max(0, Number(form.get("gracePeriodDays") || 30)),
        ),
        reviewInterval: String(
          form.get("reviewInterval") || "quarterly",
        ) as AutomationPolicy["reviewInterval"],
        reviewAnchorDay: Math.min(
          28,
          Math.max(1, Number(form.get("reviewAnchorDay") || 1)),
        ),
      };
      await prisma.shop.update({
        where: { id: shop.id },
        data: {
          spendPolicy,
          automationPolicy,
          settingsVersion: { increment: 1 },
        },
      });
      await writeAuditLog(prisma, {
        shopId: shop.id,
        actor: session.shop,
        action: "automation.policy_update",
        entityType: "Shop",
        entityId: shop.id,
        summary: "Updated spend and automation policies",
      });
      return { ok: true, message: "Policies saved. New rules apply on the next recalculation." };
    }

    if (intent === "pause") {
      await prisma.shop.update({
        where: { id: shop.id },
        data: { automationPaused: true },
      });
      await writeAuditLog(prisma, {
        shopId: shop.id,
        actor: session.shop,
        action: "automation.pause",
        entityType: "Shop",
        entityId: shop.id,
        summary: "Automation paused",
      });
      return {
        ok: true,
        message:
          "Automation paused. Spend still recalculates for reporting, but effective tiers will not change automatically.",
      };
    }

    if (intent === "resume") {
      await prisma.shop.update({
        where: { id: shop.id },
        data: { automationPaused: false },
      });
      await writeAuditLog(prisma, {
        shopId: shop.id,
        actor: session.shop,
        action: "automation.resume",
        entityType: "Shop",
        entityId: shop.id,
        summary: "Automation resumed",
      });
      return { ok: true, message: "Automation resumed. Run recalculation to apply pending changes." };
    }

    if (intent === "run_recalc") {
      // Run inline so production works even when a separate worker process is offline.
      const result = await recalculateShopCustomers(prisma, shop.id, session.shop);

      // Best-effort: refresh wholesale tags for profiles (storefront Path A).
      let tagsSynced = 0;
      try {
        const { syncCustomerWholesaleAccess } = await import("../services/wholesale/access-sync");
        const profiles = await prisma.customerProfiles.findMany({
          where: { shopId: shop.id },
          select: { id: true },
          take: 200,
        });
        for (const p of profiles) {
          const sync = await syncCustomerWholesaleAccess(prisma, admin, {
            shopId: shop.id,
            shopDomain: session.shop,
            customerProfileId: p.id,
            actor: session.shop,
          });
          if (sync.ok) tagsSynced += 1;
        }
      } catch {
        // Tag sync is best-effort; assignment still succeeded.
      }

      await writeAuditLog(prisma, {
        shopId: shop.id,
        actor: session.shop,
        action: "automation.recalc_manual",
        entityType: "Shop",
        entityId: shop.id,
        summary: `Manual recalculation processed ${result.processed} customers`,
      });

      return {
        ok: true,
        message: `Recalculation complete: ${result.processed} customer${result.processed === 1 ? "" : "s"} updated. Wholesale tags refreshed for ${tagsSynced}.`,
      };
    }

    if (intent === "start_import") {
      await enqueueJob(prisma, {
        shopDomain: session.shop,
        shopId: shop.id,
        type: JOB_TYPES.IMPORT_ORDERS,
        payload: { cursor: null },
        idempotencyKey: `import-orders:${session.shop}:${Date.now()}`,
      });
      await enqueueJob(prisma, {
        shopDomain: session.shop,
        shopId: shop.id,
        type: JOB_TYPES.IMPORT_CUSTOMERS,
        payload: { cursor: null },
        idempotencyKey: `import-customers:${session.shop}:${Date.now()}`,
      });
      await prisma.shop.update({
        where: { id: shop.id },
        data: { importStatus: "IN_PROGRESS" },
      });
      // Also kick an inline seed path reminder — worker still needed for paginated Admin GraphQL import.
      return {
        ok: true,
        message:
          "Import jobs queued. A background worker must process Shopify Admin pagination. After import finishes, use “Run recalculation now”.",
      };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Failed" };
  }
  return { ok: false, message: "Unknown action" };
};

export default function AutomationPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const s = data.spendPolicy;
  const a = data.automationPolicy;

  return (
    <s-page heading="Automation">
      {actionData?.message ? (
        <FlashBanner message={actionData.message} ok={actionData.ok} />
      ) : null}

      <PageIntro>
        Rolling spend → eligibility → tier assignment → storefront tags. Upgrades apply per policy;
        downgrades can wait on a grace period.{" "}
        <AdminLink to="/app/simulator">Test with the simulator</AdminLink> before changing live rules.
      </PageIntro>

      <StatGrid>
        <StatCard
          label="Automation"
          value={data.automationPaused ? "Paused" : "Running"}
          hint={data.automationPaused ? "Effective tiers frozen" : "Policy-driven changes on"}
        />
        <StatCard label="Customers" value={data.customerCount} hint={`${data.tierCount} active tiers`} />
        <StatCard
          label="Pending reviews"
          value={data.pendingReviews}
          hint="Deferred upgrades/downgrades"
        />
        <StatCard
          label="Last recalculation"
          value={formatDateTime(data.lastRecalculationAt)}
          hint={`Next: ${formatDateTime(data.nextScheduledRunAt)}`}
        />
      </StatGrid>

      <s-section heading="How automation works">
        <div className="vpm-panel vpm-panel--subdued">
          <ol className="vpm-steps" style={{ margin: 0, paddingLeft: "1.25rem", lineHeight: 1.6 }}>
            <li>
              Qualifying spend is calculated over a rolling {s.rollingPeriodMonths}-month window (shop
              timezone).
            </li>
            <li>Each customer is matched to the highest tier that passes spend + eligibility.</li>
            <li>
              Upgrades: <strong>{a.upgradeMode.replace("_", " ")}</strong>. Downgrades:{" "}
              <strong>{a.downgradeMode.replace("_", " ")}</strong>
              {a.downgradeMode === "grace_period" ? ` (${a.gracePeriodDays} days)` : ""}.
            </li>
            <li>
              After assignment, wholesale tags (<code>vpm-approved</code>, <code>vpm-pct-*</code>) refresh
              so the theme shows the right prices.
            </li>
          </ol>
        </div>
      </s-section>

      <s-section heading="Controls">
        <div className="vpm-panel">
          {data.historyAccessLimited ? (
            <s-banner tone="warning" heading="Incomplete order history">
              Coverage is about {data.historyCoverageMonths ?? "unknown"} months. Auto-downgrades from
              incomplete data stay blocked while protection is on.
            </s-banner>
          ) : null}
          {data.tierCount === 0 ? (
            <s-banner tone="info" heading="No active tiers">
              Create tiers before recalculation can assign pricing.{" "}
              <AdminLink to="/app/tiers">Open tiers</AdminLink>
            </s-banner>
          ) : null}

          <div className="vpm-actions" style={{ flexWrap: "wrap", gap: "0.75rem", marginTop: "0.75rem" }}>
            <Form method="post">
              <input
                type="hidden"
                name="intent"
                value={data.automationPaused ? "resume" : "pause"}
              />
              <SubmitButton disabled={busy}>
                {data.automationPaused ? "Resume automation" : "Pause automation"}
              </SubmitButton>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="run_recalc" />
              <SubmitButton disabled={busy || data.tierCount === 0}>
                {busy && navigation.formData?.get("intent") === "run_recalc"
                  ? "Recalculating…"
                  : "Run recalculation now"}
              </SubmitButton>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="start_import" />
              <SubmitButton disabled={busy}>Start historical import</SubmitButton>
            </Form>
            <AdminLink to="/app/simulator" className="vpm-btn vpm-btn--secondary">
              Open simulator
            </AdminLink>
            <AdminLink to="/app/activity" className="vpm-btn vpm-btn--secondary">
              Activity log
            </AdminLink>
          </div>
          <p className="vpm-stat-hint" style={{ marginTop: "0.75rem" }}>
            Import status: <strong>{data.importStatus}</strong>
            {data.importProgress != null ? ` · progress ${data.importProgress}%` : ""}
            {data.failedCount > 0 ? ` · ${data.failedCount} failed background job(s)` : ""}
          </p>
        </div>
      </s-section>

      <s-section heading="Spend rules">
        <div className="vpm-panel">
          <Form method="post" className="vpm-form-stack">
            <input type="hidden" name="intent" value="save_policies" />
            <Field
              label="Rolling period (months)"
              name="rollingPeriodMonths"
              type="number"
              min={1}
              max={36}
              defaultValue={s.rollingPeriodMonths}
            />
            <div className="vpm-check-grid">
              <Check label="Include tax in qualifying spend" name="includeTax" defaultChecked={s.includeTax} />
              <Check
                label="Include shipping in qualifying spend"
                name="includeShipping"
                defaultChecked={s.includeShipping}
              />
              <Check
                label="Exclude gift cards"
                name="excludeGiftCards"
                defaultChecked={s.excludeGiftCards}
              />
              <Check
                label="Exclude cancelled orders"
                name="excludeCancelled"
                defaultChecked={s.excludeCancelled}
              />
              <Check
                label="Exclude test orders"
                name="excludeTestOrders"
                defaultChecked={s.excludeTestOrders}
              />
              <Check
                label="Block auto-downgrade when history is incomplete"
                name="protectFromIncompleteHistoryDowngrade"
                defaultChecked={s.protectFromIncompleteHistoryDowngrade}
              />
            </div>

            <s-heading>Assignment timing</s-heading>
            <SelectField label="Upgrade mode" name="upgradeMode" defaultValue={a.upgradeMode}>
              <option value="immediate">Immediate — apply as soon as spend qualifies</option>
              <option value="next_review">Next review — wait for review cycle</option>
            </SelectField>
            <SelectField label="Downgrade mode" name="downgradeMode" defaultValue={a.downgradeMode}>
              <option value="immediate">Immediate</option>
              <option value="grace_period">Grace period — keep current tier temporarily</option>
              <option value="next_review">Next review</option>
            </SelectField>
            <Field
              label="Grace period (days)"
              name="gracePeriodDays"
              type="number"
              min={0}
              max={365}
              defaultValue={a.gracePeriodDays}
            />
            <SelectField label="Review interval" name="reviewInterval" defaultValue={a.reviewInterval}>
              <option value="none">None</option>
              <option value="quarterly">Quarterly</option>
              <option value="semi_annual">Semi-annual</option>
              <option value="annual">Annual</option>
            </SelectField>
            <Field
              label="Review anchor day (1–28)"
              name="reviewAnchorDay"
              type="number"
              min={1}
              max={28}
              defaultValue={a.reviewAnchorDay}
            />

            <p className="vpm-stat-hint">
              Product/collection exclusions for spend live in{" "}
              <AdminLink to="/app/settings">Settings</AdminLink>.
            </p>

            <SubmitButton disabled={busy}>Save policies</SubmitButton>
          </Form>
        </div>
      </s-section>

      <s-section heading="Recent background jobs">
        <div className="vpm-panel" style={{ padding: 0, overflow: "auto" }}>
          {data.jobs.length === 0 ? (
            <div style={{ padding: "1rem" }}>
              <s-paragraph>
                No queued jobs yet. Recalculation above runs immediately in this request. Import still
                uses background jobs when a worker is available.
              </s-paragraph>
            </div>
          ) : (
            <table className="vpm-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Updated</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <code>{j.type}</code>
                    </td>
                    <td>{j.status}</td>
                    <td>{j.attempts}</td>
                    <td>{formatDateTime(j.updatedAt)}</td>
                    <td>{j.lastError || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
