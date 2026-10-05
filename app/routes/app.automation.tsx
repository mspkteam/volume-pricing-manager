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
import { enqueueJob, JOB_TYPES } from "../services/jobs/queue";
import { writeAuditLog } from "../services/audit/audit-log";
import type { AutomationPolicy, SpendPolicy } from "../lib/policies";
import { FlashBanner, PageIntro, StatCard, StatGrid } from "../components/admin/ui";
import { formatDateTime } from "../lib/format";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const spendPolicy = parseSpendPolicy(shop.spendPolicy);
  const automationPolicy = parseAutomationPolicy(shop.automationPolicy);
  const jobs = await prisma.backgroundJobs.findMany({
    where: { shopDomain: session.shop },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });
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
    jobs: jobs.map((j) => ({
      id: j.id,
      type: j.type,
      status: j.status,
      attempts: j.attempts,
      lastError: j.lastError,
      runAfter: j.runAfter,
      updatedAt: j.updatedAt,
    })),
    failedCount: failed.length,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    if (intent === "save_policies") {
      const spendPolicy: SpendPolicy = {
        ...parseSpendPolicy(shop.spendPolicy),
        rollingPeriodMonths: Number(form.get("rollingPeriodMonths") || 12),
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
        gracePeriodDays: Number(form.get("gracePeriodDays") || 30),
        reviewInterval: String(
          form.get("reviewInterval") || "quarterly",
        ) as AutomationPolicy["reviewInterval"],
        reviewAnchorDay: Number(form.get("reviewAnchorDay") || 1),
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
      return { ok: true, message: "Policies saved." };
    }
    if (intent === "pause") {
      await prisma.shop.update({
        where: { id: shop.id },
        data: { automationPaused: true },
      });
      return { ok: true, message: "Automation paused." };
    }
    if (intent === "resume") {
      await prisma.shop.update({
        where: { id: shop.id },
        data: { automationPaused: false },
      });
      return { ok: true, message: "Automation resumed." };
    }
    if (intent === "run_recalc") {
      await enqueueJob(prisma, {
        shopDomain: session.shop,
        shopId: shop.id,
        type: JOB_TYPES.DAILY_RECALC,
        payload: { manual: true },
        idempotencyKey: `manual-recalc:${session.shop}:${Date.now()}`,
      });
      return { ok: true, message: "Shop recalculation job enqueued. Ensure the worker is running." };
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
      return {
        ok: true,
        message:
          "Import jobs enqueued. Worker must be running with Admin API access. Full 12-month history needs read_all_orders approval.",
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
  const s = data.spendPolicy;
  const a = data.automationPolicy;

  return (
    <s-page heading="Automation">
      {actionData?.message ? (
        <FlashBanner message={actionData.message} ok={actionData.ok} />
      ) : null}

      <PageIntro>
        Control rolling spend rules, upgrade/downgrade behavior, and background jobs. The worker process
        must be running for imports and scheduled recalculations.
      </PageIntro>

      <StatGrid>
        <StatCard
          label="Automation"
          value={data.automationPaused ? "Paused" : "Running"}
        />
        <StatCard label="Failed jobs" value={data.failedCount} />
        <StatCard label="Import" value={data.importStatus} />
        <StatCard
          label="Next run"
          value={formatDateTime(data.nextScheduledRunAt)}
          hint={`Last: ${formatDateTime(data.lastRecalculationAt)}`}
        />
      </StatGrid>

      <s-section heading="Status">
        {data.historyAccessLimited ? (
          <s-banner tone="warning">
            Insufficient history — coverage {data.historyCoverageMonths ?? "unknown"} months. Downgrades
            from incomplete data may be blocked.
          </s-banner>
        ) : null}
        <s-stack direction="inline" gap="base">
          <Form method="post">
            <input type="hidden" name="intent" value={data.automationPaused ? "resume" : "pause"} />
            <s-button type="submit">{data.automationPaused ? "Resume" : "Pause"}</s-button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="run_recalc" />
            <s-button type="submit" variant="secondary">
              Run recalculation now
            </s-button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="start_import" />
            <s-button type="submit" variant="tertiary">
              Start historical import
            </s-button>
          </Form>
        </s-stack>
      </s-section>

      <s-section heading="Policies">
        <Form method="post">
          <input type="hidden" name="intent" value="save_policies" />
          <s-stack direction="block" gap="base">
            <s-text-field
              name="rollingPeriodMonths"
              label="Rolling period (months)"
              value={String(s.rollingPeriodMonths)}
            />
            <label>
              <input type="checkbox" name="includeTax" defaultChecked={s.includeTax} /> Include tax
            </label>
            <label>
              <input type="checkbox" name="includeShipping" defaultChecked={s.includeShipping} />{" "}
              Include shipping
            </label>
            <label>
              <input type="checkbox" name="excludeGiftCards" defaultChecked={s.excludeGiftCards} />{" "}
              Exclude gift cards
            </label>
            <label>
              <input type="checkbox" name="excludeCancelled" defaultChecked={s.excludeCancelled} />{" "}
              Exclude cancelled
            </label>
            <label>
              <input type="checkbox" name="excludeTestOrders" defaultChecked={s.excludeTestOrders} />{" "}
              Exclude test orders
            </label>
            <label>
              <input
                type="checkbox"
                name="protectFromIncompleteHistoryDowngrade"
                defaultChecked={s.protectFromIncompleteHistoryDowngrade}
              />{" "}
              Block auto-downgrade when history is incomplete
            </label>
            <select name="upgradeMode" defaultValue={a.upgradeMode}>
              <option value="immediate">Upgrade: immediate</option>
              <option value="next_review">Upgrade: next review</option>
            </select>
            <select name="downgradeMode" defaultValue={a.downgradeMode}>
              <option value="immediate">Downgrade: immediate</option>
              <option value="grace_period">Downgrade: grace period</option>
              <option value="next_review">Downgrade: next review</option>
            </select>
            <s-text-field
              name="gracePeriodDays"
              label="Grace period (days)"
              value={String(a.gracePeriodDays)}
            />
            <select name="reviewInterval" defaultValue={a.reviewInterval}>
              <option value="none">Review: none</option>
              <option value="quarterly">Quarterly</option>
              <option value="semi_annual">Semi-annual</option>
              <option value="annual">Annual</option>
            </select>
            <s-text-field
              name="reviewAnchorDay"
              label="Review anchor day (1–28)"
              value={String(a.reviewAnchorDay)}
            />
            <s-button type="submit">Save policies</s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Recent jobs">
        {data.jobs.length === 0 ? (
          <s-paragraph>No jobs yet. Start the worker with `npm run worker`.</s-paragraph>
        ) : (
          <s-unordered-list>
            {data.jobs.map((j) => (
              <s-list-item key={j.id}>
                {j.type} · {j.status} · attempts {j.attempts}
                {j.lastError ? ` · ${j.lastError}` : ""}
              </s-list-item>
            ))}
          </s-unordered-list>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
