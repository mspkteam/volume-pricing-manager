/**
 * Independent worker process — polls durable jobs and runs scheduled tasks.
 * Start with: npm run worker
 */

import prisma from "./db.server";
import {
  claimNextJobs,
  completeJob,
  createWorkerId,
  enqueueJob,
  failJob,
  JOB_TYPES,
} from "./services/jobs/queue";
import { recalculateCustomer, recalculateShopCustomers } from "./services/assignment/recalculate";
import { getPricingProvider } from "./services/pricing/discount-function-provider";
import { ensureShop, markShopUninstalled } from "./services/shop/shop-service";
import { upsertNormalizedOrder, type ShopifyOrderLike } from "./services/orders/normalize-order";
import { writeAuditLog } from "./services/audit/audit-log";
import {
  finalizeImportCoverage,
  importOrdersPage,
} from "./services/orders/import-orders";
import { parseSpendPolicy } from "./services/shop/shop-service";
import { unauthenticated } from "./shopify.server";

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 2000);
const workerId = createWorkerId();

async function handleJob(job: Awaited<ReturnType<typeof claimNextJobs>>[number]) {
  const payload = job.payload as Record<string, unknown>;

  switch (job.type) {
    case JOB_TYPES.RECALCULATE_CUSTOMER: {
      const shop = await ensureShop(prisma, job.shopDomain);
      await recalculateCustomer(prisma, {
        shopId: shop.id,
        shopDomain: job.shopDomain,
        customerProfileId: String(payload.customerProfileId),
        actor: String(payload.actor ?? "worker"),
      });
      break;
    }
    case JOB_TYPES.RECALCULATE_SHOP:
    case JOB_TYPES.DAILY_RECALC: {
      const shop = await ensureShop(prisma, job.shopDomain);
      if (shop.uninstalledAt || shop.automationPaused) {
        break;
      }
      await recalculateShopCustomers(prisma, shop.id, job.shopDomain);
      // Schedule next daily run
      await enqueueJob(prisma, {
        shopDomain: job.shopDomain,
        shopId: shop.id,
        type: JOB_TYPES.DAILY_RECALC,
        payload: {},
        runAfter: new Date(Date.now() + 24 * 60 * 60 * 1000),
        idempotencyKey: `daily-recalc:${job.shopDomain}:${new Date().toISOString().slice(0, 10)}`,
      });
      break;
    }
    case JOB_TYPES.SYNC_PRICING_CUSTOMER: {
      const shop = await ensureShop(prisma, job.shopDomain);
      const writesEnabled = process.env.PRICING_WRITES_ENABLED === "true";
      const provider = getPricingProvider(shop.pricingProvider, null, writesEnabled);
      const customer = await prisma.customerProfiles.findFirst({
        where: { id: String(payload.customerProfileId), shopId: shop.id },
      });
      if (!customer) break;

      // Concurrency: skip if a newer assignment version already exists
      const expectedVersion = Number(payload.assignmentVersion ?? 0);
      if (customer.assignmentVersion > expectedVersion) {
        break;
      }

      const result = await provider.syncCustomer({
        shopDomain: job.shopDomain,
        shopifyCustomerId: customer.shopifyCustomerId,
        tierId: (payload.tierId as string | null) ?? customer.effectiveTierId,
        discountBps: Number(payload.discountBps ?? 0),
        tierName: null,
        configVersion: Number(payload.configVersion ?? shop.settingsVersion),
        assignmentVersion: expectedVersion,
      });

      await prisma.customerProfiles.update({
        where: { id: customer.id },
        data: {
          pricingSyncStatus: result.status,
          pricingLastSyncedAt: result.status === "SYNCED" ? new Date() : customer.pricingLastSyncedAt,
          pricingLastError: result.status === "FAILED" ? result.message : null,
          pricingExternalRef: result.externalRef ?? customer.pricingExternalRef,
        },
      });

      await prisma.pricingSyncJobs.create({
        data: {
          shopId: shop.id,
          customerProfileId: customer.id,
          configVersion: Number(payload.configVersion ?? shop.settingsVersion),
          assignmentVersion: expectedVersion,
          desiredTierId: (payload.tierId as string | null) ?? null,
          desiredDiscountBps: Number(payload.discountBps ?? 0),
          status: result.status,
          lastError: result.status === "FAILED" ? result.message : null,
          providerResponse: (result.details as object | undefined) ?? undefined,
          completedAt: new Date(),
        },
      });

      if (result.status === "FAILED") {
        throw new Error(result.message);
      }
      break;
    }
    case JOB_TYPES.PROCESS_WEBHOOK: {
      await processWebhookPayload(job.shopDomain, payload);
      break;
    }
    case JOB_TYPES.EXPIRE_OVERRIDES: {
      const shop = await ensureShop(prisma, job.shopDomain);
      const expired = await prisma.customerProfiles.findMany({
        where: {
          shopId: shop.id,
          overrideExpiresAt: { lte: new Date() },
          overrideTierId: { not: null },
        },
      });
      for (const c of expired) {
        await recalculateCustomer(prisma, {
          shopId: shop.id,
          shopDomain: job.shopDomain,
          customerProfileId: c.id,
          actor: "override-expiry",
        });
      }
      break;
    }
    case JOB_TYPES.IMPORT_ORDERS: {
      const shop = await ensureShop(prisma, job.shopDomain);
      const { admin } = await unauthenticated.admin(job.shopDomain);
      const page = await importOrdersPage(
        prisma,
        admin,
        shop.id,
        shop.currencyCode,
        (payload.cursor as string | null) ?? null,
      );
      if (page.hasNextPage) {
        await enqueueJob(prisma, {
          shopDomain: job.shopDomain,
          shopId: shop.id,
          type: JOB_TYPES.IMPORT_ORDERS,
          payload: { cursor: page.cursor },
          idempotencyKey: `import-orders:${job.shopDomain}:${page.cursor}`,
        });
      } else {
        const spendPolicy = parseSpendPolicy(shop.spendPolicy);
        await finalizeImportCoverage(prisma, shop.id, spendPolicy.rollingPeriodMonths);
        await enqueueJob(prisma, {
          shopDomain: job.shopDomain,
          shopId: shop.id,
          type: JOB_TYPES.RECALCULATE_SHOP,
          payload: {},
          idempotencyKey: `recalc-after-import:${job.shopDomain}:${Date.now()}`,
        });
      }
      break;
    }
    case JOB_TYPES.IMPORT_CUSTOMERS: {
      // Customers are created as a side effect of order import / webhooks.
      // Placeholder keeps the job type durable for future bulk customer sync.
      break;
    }
    default:
      console.warn(`[worker] Unknown job type: ${job.type}`);
  }
}

async function processWebhookPayload(shopDomain: string, payload: Record<string, unknown>) {
  const topic = String(payload.topic ?? "");
  const body = payload.body as Record<string, unknown>;

  if (topic === "app/uninstalled") {
    await markShopUninstalled(prisma, shopDomain);
    return;
  }

  const shop = await ensureShop(prisma, shopDomain);

  if (topic.startsWith("orders/") || topic === "refunds/create") {
    await upsertNormalizedOrder(
      prisma,
      shop.id,
      shop.currencyCode,
      body as unknown as ShopifyOrderLike,
    );
    const customerId =
      (body as { customer?: { admin_graphql_api_id?: string; id?: number } }).customer
        ?.admin_graphql_api_id ??
      ((body as { customer?: { id?: number } }).customer?.id
        ? `gid://shopify/Customer/${(body as { customer: { id: number } }).customer.id}`
        : null);
    if (customerId) {
      const profile = await prisma.customerProfiles.findUnique({
        where: {
          shopId_shopifyCustomerId: { shopId: shop.id, shopifyCustomerId: customerId },
        },
      });
      if (profile) {
        await enqueueJob(prisma, {
          shopDomain,
          shopId: shop.id,
          type: JOB_TYPES.RECALCULATE_CUSTOMER,
          payload: { customerProfileId: profile.id, actor: `webhook:${topic}` },
          idempotencyKey: `recalc:${profile.id}:${String(payload.webhookEventId ?? Date.now())}`,
        });
      }
    }
    await prisma.shop.update({
      where: { id: shop.id },
      data: { lastSuccessfulSyncAt: new Date() },
    });
  }

  if (topic.startsWith("customers/")) {
    // customers/update, customers/create — ensure profile exists
    const gid =
      (body as { admin_graphql_api_id?: string }).admin_graphql_api_id ??
      `gid://shopify/Customer/${(body as { id?: number }).id}`;
    await prisma.customerProfiles.upsert({
      where: { shopId_shopifyCustomerId: { shopId: shop.id, shopifyCustomerId: gid } },
      create: {
        shopId: shop.id,
        shopifyCustomerId: gid,
        email: (body as { email?: string }).email ?? null,
        displayName:
          [(body as { first_name?: string }).first_name, (body as { last_name?: string }).last_name]
            .filter(Boolean)
            .join(" ") || null,
      },
      update: {
        email: (body as { email?: string }).email ?? undefined,
        displayName:
          [(body as { first_name?: string }).first_name, (body as { last_name?: string }).last_name]
            .filter(Boolean)
            .join(" ") || undefined,
      },
    });
  }
}

async function scheduleMaintenance() {
  const shops = await prisma.shop.findMany({
    where: { uninstalledAt: null, automationPaused: false },
  });
  for (const shop of shops) {
    await enqueueJob(prisma, {
      shopDomain: shop.shopDomain,
      shopId: shop.id,
      type: JOB_TYPES.EXPIRE_OVERRIDES,
      payload: {},
      idempotencyKey: `expire-overrides:${shop.shopDomain}:${new Date().toISOString().slice(0, 13)}`,
    });
    const needsDaily =
      !shop.nextScheduledRunAt || shop.nextScheduledRunAt <= new Date();
    if (needsDaily) {
      await enqueueJob(prisma, {
        shopDomain: shop.shopDomain,
        shopId: shop.id,
        type: JOB_TYPES.DAILY_RECALC,
        payload: {},
        idempotencyKey: `daily-recalc:${shop.shopDomain}:${new Date().toISOString().slice(0, 10)}`,
      });
    }
  }
}

async function loop() {
  console.log(`[worker] started ${workerId}`);
  let ticks = 0;
  for (;;) {
    try {
      ticks += 1;
      if (ticks % 30 === 0) {
        await scheduleMaintenance();
      }
      const jobs = await claimNextJobs(prisma, workerId, 5);
      for (const job of jobs) {
        try {
          await handleJob(job);
          await completeJob(prisma, job.id, { ok: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[worker] job ${job.id} failed:`, message);
          await failJob(prisma, job.id, message);
        }
      }
    } catch (err) {
      console.error("[worker] loop error:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

loop().catch(async (err) => {
  console.error("[worker] fatal", err);
  await writeAuditLog(prisma, {
    shopId: "system",
    actor: workerId,
    action: "worker.fatal",
    entityType: "Worker",
    summary: "Worker process crashed",
  }).catch(() => undefined);
  process.exit(1);
});
