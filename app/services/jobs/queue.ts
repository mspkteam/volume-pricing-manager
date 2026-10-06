/**
 * Durable shop-scoped background job queue backed by PostgreSQL.
 * Worker process polls independently of browser requests.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";

export type EnqueueJobInput = {
  shopDomain: string;
  shopId?: string | null;
  type: string;
  payload: Prisma.InputJsonValue;
  runAfter?: Date;
  priority?: number;
  maxAttempts?: number;
  idempotencyKey?: string;
};

export async function enqueueJob(prisma: PrismaClient, input: EnqueueJobInput) {
  const idempotencyKey =
    input.idempotencyKey ??
    createHash("sha256")
      .update(`${input.shopDomain}:${input.type}:${JSON.stringify(input.payload)}:${input.runAfter?.toISOString() ?? ""}`)
      .digest("hex")
      .slice(0, 32);

  try {
    return await prisma.backgroundJobs.create({
      data: {
        shopDomain: input.shopDomain,
        shopId: input.shopId ?? null,
        type: input.type,
        payload: input.payload,
        runAfter: input.runAfter ?? new Date(),
        priority: input.priority ?? 100,
        maxAttempts: input.maxAttempts ?? 5,
        idempotencyKey,
        status: "PENDING",
      },
    });
  } catch (error: unknown) {
    // Unique idempotency — return existing
    const existing = await prisma.backgroundJobs.findUnique({
      where: {
        shopDomain_idempotencyKey: {
          shopDomain: input.shopDomain,
          idempotencyKey,
        },
      },
    });
    if (existing) return existing;
    throw error;
  }
}

export async function claimNextJobs(
  prisma: PrismaClient,
  workerId: string,
  limit = 5,
) {
  const now = new Date();
  // Simple FOR UPDATE SKIP LOCKED pattern via raw SQL for concurrency safety
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "BackgroundJobs"
    SET status = 'RUNNING',
        "lockedAt" = ${now},
        "lockedBy" = ${workerId},
        attempts = attempts + 1,
        "updatedAt" = ${now}
    WHERE id IN (
      SELECT id FROM "BackgroundJobs"
      WHERE status = 'PENDING'
        AND "runAfter" <= ${now}
      ORDER BY priority ASC, "runAfter" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING id
  `;

  if (rows.length === 0) return [];
  return prisma.backgroundJobs.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
  });
}

export async function completeJob(
  prisma: PrismaClient,
  jobId: string,
  result?: Prisma.InputJsonValue,
) {
  return prisma.backgroundJobs.update({
    where: { id: jobId },
    data: {
      status: "COMPLETED",
      result: result ?? undefined,
      completedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
    },
  });
}

export async function failJob(
  prisma: PrismaClient,
  jobId: string,
  error: string,
  opts?: { retryDelayMs?: number },
) {
  const job = await prisma.backgroundJobs.findUniqueOrThrow({ where: { id: jobId } });
  const attempts = job.attempts;
  if (attempts >= job.maxAttempts) {
    return prisma.backgroundJobs.update({
      where: { id: jobId },
      data: {
        status: "DEAD",
        lastError: error.slice(0, 2000),
        completedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
      },
    });
  }

  const delay = opts?.retryDelayMs ?? Math.min(60_000 * 2 ** Math.max(attempts - 1, 0), 3600_000);
  return prisma.backgroundJobs.update({
    where: { id: jobId },
    data: {
      status: "PENDING",
      lastError: error.slice(0, 2000),
      runAfter: new Date(Date.now() + delay),
      lockedAt: null,
      lockedBy: null,
    },
  });
}

export function createWorkerId(): string {
  return `worker-${randomUUID().slice(0, 8)}`;
}

export const JOB_TYPES = {
  IMPORT_CUSTOMERS: "import_customers",
  IMPORT_ORDERS: "import_orders",
  PROCESS_WEBHOOK: "process_webhook",
  RECALCULATE_CUSTOMER: "recalculate_customer",
  RECALCULATE_SHOP: "recalculate_shop",
  DAILY_RECALC: "daily_recalc",
  RECONCILE_ORDERS: "reconcile_orders",
  SYNC_PRICING_CUSTOMER: "sync_pricing_customer",
  SYNC_PRICING_SHOP: "sync_pricing_shop",
  SYNC_WHOLESALE_ACCESS: "sync_wholesale_access",
  EXPIRE_OVERRIDES: "expire_overrides",
} as const;
