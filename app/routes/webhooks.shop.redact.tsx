import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { markShopUninstalled } from "../services/shop/shop-service";

/** shop/redact — purge shop data 48h after uninstall per Shopify compliance */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Compliance webhook ${topic} for ${shop}`);

  await markShopUninstalled(prisma, shop);

  const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: shop } });
  if (shopRecord) {
    // Cascade deletes via Prisma relations
    await prisma.shop.delete({ where: { id: shopRecord.id } });
  }
  await prisma.session.deleteMany({ where: { shop } });

  return new Response();
};
