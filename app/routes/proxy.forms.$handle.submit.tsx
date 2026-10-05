import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import { submitFormApplication } from "../services/forms/submit-service";
import { rateLimit } from "../services/forms/rate-limit";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);
  return Response.json({ error: "Method not allowed" }, { status: 405 });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session?.shop) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const shop = await ensureShop(prisma, session.shop);
  const handle = String(params.handle || "");
  const url = new URL(request.url);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rl = rateLimit(`submit:${shop.id}:${ip}`, 20, 60_000);
  if (!rl.ok) {
    return Response.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const loggedInCustomerId = url.searchParams.get("logged_in_customer_id");

  let body: {
    answers?: Record<string, unknown>;
    cacheKey?: string;
    idempotencyKey?: string;
    customerEmail?: string;
    customerDisplayName?: string;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const idempotencyKey = String(body.idempotencyKey || "").trim();
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return Response.json({ error: "idempotencyKey required" }, { status: 400 });
  }

  try {
    const result = await submitFormApplication(prisma, {
      shopId: shop.id,
      shopDomain: session.shop,
      formHandle: handle,
      answers: body.answers || {},
      cacheKey: String(body.cacheKey || ""),
      idempotencyKey,
      shopifyCustomerId: loggedInCustomerId || null,
      customerEmail: body.customerEmail || null,
      customerDisplayName: body.customerDisplayName || null,
    });
    return Response.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (err) {
    if (err instanceof Response) return err;
    return Response.json(
      { error: err instanceof Error ? err.message : "Submit failed" },
      { status: 500 },
    );
  }
};
