import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import { writeAuditLog } from "../services/audit/audit-log";

/** customers/redact — delete customer profile data for the shop */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);
  console.log(`Compliance webhook ${topic} for ${shop}`);

  const customerId = (payload as { customer?: { id?: number } })?.customer?.id;
  if (customerId) {
    const shopRecord = await ensureShop(prisma, shop);
    const gid = `gid://shopify/Customer/${customerId}`;
    const profile = await prisma.customerProfiles.findUnique({
      where: { shopId_shopifyCustomerId: { shopId: shopRecord.id, shopifyCustomerId: gid } },
    });
    if (profile) {
      await prisma.customerProfiles.delete({ where: { id: profile.id } });
      await writeAuditLog(prisma, {
        shopId: shopRecord.id,
        actor: "shopify-compliance",
        action: "privacy.customer_redact",
        entityType: "CustomerProfile",
        entityId: profile.id,
        summary: "Redacted customer profile per compliance webhook",
      });
    }
  }

  return new Response();
};
