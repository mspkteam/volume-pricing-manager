import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopOrThrow } from "../services/shop/shop-service";
import { writeAuditLog } from "../services/audit/audit-log";

/**
 * GDPR / privacy compliance: customers/data_request
 * Returns acknowledgment; merchant support can export via admin Activity + DB.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);
  console.log(`Compliance webhook ${topic} for ${shop}`);

  try {
    const shopRecord = await getShopOrThrow(prisma, shop);
    await writeAuditLog(prisma, {
      shopId: shopRecord.id,
      actor: "shopify-compliance",
      action: "privacy.data_request",
      entityType: "Customer",
      entityId: String((payload as { customer?: { id?: number } })?.customer?.id ?? ""),
      summary: "Received customers/data_request compliance webhook",
      metadata: { topic },
    });
  } catch {
    // Shop may already be gone
  }

  return new Response();
};
