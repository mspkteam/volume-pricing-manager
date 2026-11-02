import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import {
  ensureWarrantySettings,
  toWarrantySettingsView,
} from "../services/warranty/settings";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session?.shop) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const shop = await ensureShop(prisma, session.shop);
  const settings = await ensureWarrantySettings(prisma, shop.id);
  return Response.json({
    settings: toWarrantySettingsView(settings),
    currencyCode: shop.currencyCode,
  });
};
