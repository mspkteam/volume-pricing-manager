import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import { getPublishedByHandle } from "../services/forms/form-service";
import { toStorefrontSchema } from "../services/forms/storefront-schema";
import type { FormSchema } from "../services/forms/field-registry";
import { rateLimit } from "../services/forms/rate-limit";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session?.shop) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shop = await ensureShop(prisma, session.shop);
  const handle = String(params.handle || "");
  const url = new URL(request.url);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rl = rateLimit(`schema:${shop.id}:${ip}`, 60, 60_000);
  if (!rl.ok) {
    return Response.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const form = await getPublishedByHandle(prisma, shop.id, handle);
  if (!form || !form.publishedSchema || form.publishedVersion == null || !form.publishedCacheKey) {
    return Response.json({ error: "Form not found" }, { status: 404 });
  }

  const tiers = await prisma.pricingTier.findMany({
    where: { shopId: shop.id },
    select: {
      id: true,
      name: true,
      minSpendMinor: true,
      isActive: true,
      isArchived: true,
    },
  });

  const schema = form.publishedSchema as unknown as FormSchema;
  const payload = toStorefrontSchema(schema, {
    handle: form.handle,
    cacheKey: form.publishedCacheKey,
    publishedVersion: form.publishedVersion,
    currencyCode: shop.currencyCode,
    tiers,
  });

  // logged_in_customer_id is signed by Shopify on app proxy requests
  const loggedInCustomerId = url.searchParams.get("logged_in_customer_id");

  return Response.json(
    {
      ...payload,
      loggedInCustomerId: loggedInCustomerId || null,
    },
    {
      headers: {
        "Cache-Control": "private, max-age=30",
        "Content-Type": "application/json",
      },
    },
  );
};
