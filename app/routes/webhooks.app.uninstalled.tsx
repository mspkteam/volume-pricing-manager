import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { markShopUninstalled } from "../services/shop/shop-service";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  await markShopUninstalled(db, shop);

  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
