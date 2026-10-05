import type { Shop } from "@prisma/client";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop/shop-service";

export async function requireShopFromRequest(request: Request): Promise<{
  session: Awaited<ReturnType<typeof authenticate.admin>>["session"];
  shop: Shop;
}> {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  return { session, shop };
}

export function actorLabel(session: { email?: string | null; shop: string }): string {
  if (session.email) return session.email;
  return `merchant@${session.shop}`;
}
