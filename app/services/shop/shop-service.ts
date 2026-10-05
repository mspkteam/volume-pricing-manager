/**
 * Shop-scoped data access — every query filters by shop.
 */

import type { PrismaClient, Shop } from "@prisma/client";
import {
  DEFAULT_AUTOMATION_POLICY,
  DEFAULT_SPEND_POLICY,
  type AutomationPolicy,
  type SpendPolicy,
} from "../../lib/policies";

export type ShopSettings = {
  spendPolicy: SpendPolicy;
  automationPolicy: AutomationPolicy;
};

export function parseSpendPolicy(json: unknown): SpendPolicy {
  return { ...DEFAULT_SPEND_POLICY, ...(json as Partial<SpendPolicy>) };
}

export function parseAutomationPolicy(json: unknown): AutomationPolicy {
  return { ...DEFAULT_AUTOMATION_POLICY, ...(json as Partial<AutomationPolicy>) };
}

export async function ensureShop(
  prisma: PrismaClient,
  shopDomain: string,
  extras?: Partial<Pick<Shop, "currencyCode" | "timezone" | "displayName">>,
): Promise<Shop> {
  const existing = await prisma.shop.findUnique({ where: { shopDomain } });
  if (existing) {
    if (existing.uninstalledAt) {
      return prisma.shop.update({
        where: { id: existing.id },
        data: {
          uninstalledAt: null,
          installedAt: new Date(),
          ...(extras ?? {}),
        },
      });
    }
    if (extras && (extras.currencyCode || extras.timezone || extras.displayName)) {
      return prisma.shop.update({
        where: { id: existing.id },
        data: extras,
      });
    }
    return existing;
  }

  return prisma.shop.create({
    data: {
      shopDomain,
      currencyCode: extras?.currencyCode ?? "USD",
      timezone: extras?.timezone ?? "America/New_York",
      displayName: extras?.displayName ?? "Volume Pricing Manager",
      spendPolicy: DEFAULT_SPEND_POLICY,
      automationPolicy: DEFAULT_AUTOMATION_POLICY,
    },
  });
}

export async function getShopOrThrow(prisma: PrismaClient, shopDomain: string): Promise<Shop> {
  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop || shop.uninstalledAt) {
    throw new Error(`Shop not found or uninstalled: ${shopDomain}`);
  }
  return shop;
}

/** Assert a record belongs to the shop — prevents cross-shop access */
export function assertShopScope(recordShopId: string, shopId: string, entity = "record"): void {
  if (recordShopId !== shopId) {
    throw new Error(`Forbidden: ${entity} does not belong to this shop`);
  }
}

export async function markShopUninstalled(prisma: PrismaClient, shopDomain: string): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop) return;
  await prisma.$transaction([
    prisma.shop.update({
      where: { id: shop.id },
      data: {
        uninstalledAt: new Date(),
        automationPaused: true,
        pricingStatus: "NOT_CONFIGURED",
      },
    }),
    prisma.backgroundJobs.updateMany({
      where: {
        shopId: shop.id,
        status: { in: ["PENDING", "RUNNING"] },
      },
      data: { status: "CANCELLED", completedAt: new Date() },
    }),
  ]);
}
