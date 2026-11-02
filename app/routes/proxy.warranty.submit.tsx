import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import { rateLimit } from "../services/forms/rate-limit";
import { submitWarrantyClaim } from "../services/warranty/submit";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);
  return Response.json({ error: "Method not allowed" }, { status: 405 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session?.shop) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const shop = await ensureShop(prisma, session.shop);
  const url = new URL(request.url);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rl = rateLimit(`warranty:${shop.id}:${ip}`, 15, 60_000);
  if (!rl.ok) {
    return Response.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const idempotencyKey = String(body.idempotencyKey || "").trim();
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return Response.json({ error: "idempotencyKey required" }, { status: 400 });
  }

  const loggedInCustomerId = url.searchParams.get("logged_in_customer_id");

  try {
    const result = await submitWarrantyClaim(prisma, {
      shopId: shop.id,
      shopifyCustomerId: loggedInCustomerId || null,
      customerName: (body.customerName as string) || null,
      customerEmail: String(body.customerEmail || ""),
      customerPhone: (body.customerPhone as string) || null,
      companyName: (body.companyName as string) || null,
      productSku: String(body.productSku || ""),
      productTitle: (body.productTitle as string) || null,
      orderNumber: (body.orderNumber as string) || null,
      purchaseDate: (body.purchaseDate as string) || null,
      issueDescription: String(body.issueDescription || ""),
      attachmentUrls: Array.isArray(body.attachmentUrls)
        ? (body.attachmentUrls as string[])
        : [],
      idempotencyKey,
    });

    return Response.json(
      {
        ok: true,
        duplicate: result.duplicate,
        claimNumber: result.claim.claimNumber,
        claimId: result.claim.id,
        withinWarrantyWindow: result.claim.withinWarrantyWindow,
        message: result.successMessage,
      },
      { status: result.duplicate ? 200 : 201 },
    );
  } catch (err) {
    if (err instanceof Response) return err;
    return Response.json(
      { error: err instanceof Error ? err.message : "Submit failed" },
      { status: 500 },
    );
  }
};
