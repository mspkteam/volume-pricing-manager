/**
 * Durable webhook intake with HMAC verification via Shopify authenticate.webhook.
 * Stores events idempotently and enqueues processing jobs.
 */

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createHash } from "node:crypto";
import { enqueueJob, JOB_TYPES } from "../services/jobs/queue";
import { ensureShop } from "../services/shop/shop-service";

export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop, payload, webhookId } = await authenticate.webhook(request);

  const payloadHash = createHash("sha256")
    .update(`${topic}:${webhookId ?? ""}:${JSON.stringify(payload)}`)
    .digest("hex");

  const shopRecord = await ensureShop(prisma, shop).catch(() => null);

  try {
    const event = await prisma.webhookEvents.create({
      data: {
        shopId: shopRecord?.id,
        shopDomain: shop,
        topic,
        shopifyWebhookId: webhookId ?? null,
        payloadHash,
        payload: payload as object,
        status: "PENDING",
      },
    });

    await enqueueJob(prisma, {
      shopDomain: shop,
      shopId: shopRecord?.id,
      type: JOB_TYPES.PROCESS_WEBHOOK,
      payload: {
        topic,
        body: payload,
        webhookEventId: event.id,
      },
      idempotencyKey: `webhook:${event.id}`,
      priority: 50,
    });

    await prisma.webhookEvents.update({
      where: { id: event.id },
      data: { status: "PROCESSING" },
    });
  } catch {
    // Unique constraint → duplicate delivery
    await prisma.webhookEvents.updateMany({
      where: { shopDomain: shop, topic, payloadHash },
      data: { status: "DUPLICATE" },
    });
  }

  // Always ACK quickly — processing is durable/async
  return new Response();
}
