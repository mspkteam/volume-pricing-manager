import type { PrismaClient, WarrantyClaims } from "@prisma/client";
import {
  ensureWarrantySettings,
  isWithinWarrantyWindow,
} from "./settings";

export type SubmitWarrantyClaimInput = {
  shopId: string;
  shopifyCustomerId?: string | null;
  customerName?: string | null;
  customerEmail: string;
  customerPhone?: string | null;
  companyName?: string | null;
  productSku: string;
  productTitle?: string | null;
  orderNumber?: string | null;
  purchaseDate?: string | null;
  issueDescription: string;
  attachmentUrls?: string[];
  idempotencyKey: string;
};

function claimNumber(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `WTY-${y}${m}${day}-${rand}`;
}

export async function submitWarrantyClaim(
  prisma: PrismaClient,
  input: SubmitWarrantyClaimInput,
): Promise<{ claim: WarrantyClaims; duplicate: boolean; successMessage: string }> {
  const settings = await ensureWarrantySettings(prisma, input.shopId);

  if (settings.requireLogin && !input.shopifyCustomerId) {
    throw new Response(JSON.stringify({ error: "Login required to submit a warranty claim" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const email = String(input.customerEmail || "").trim().toLowerCase();
  const sku = String(input.productSku || "").trim();
  const issue = String(input.issueDescription || "").trim();
  if (!email || !email.includes("@")) {
    throw new Response(JSON.stringify({ error: "Valid email is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!sku) {
    throw new Response(JSON.stringify({ error: "Product / SKU is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!issue || issue.length < 10) {
    throw new Response(JSON.stringify({ error: "Please describe the issue (at least 10 characters)" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (settings.requireOrderNumber && !String(input.orderNumber || "").trim()) {
    throw new Response(JSON.stringify({ error: "Order number is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let purchaseDate: Date | null = null;
  if (input.purchaseDate) {
    const parsed = new Date(input.purchaseDate);
    if (Number.isNaN(parsed.getTime())) {
      throw new Response(JSON.stringify({ error: "Invalid purchase date" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    purchaseDate = parsed;
  } else if (settings.requirePurchaseDate) {
    throw new Response(JSON.stringify({ error: "Purchase date is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const existing = await prisma.warrantyClaims.findUnique({
    where: {
      shopId_idempotencyKey: {
        shopId: input.shopId,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (existing) {
    return {
      claim: existing,
      duplicate: true,
      successMessage: settings.successMessage,
    };
  }

  const within = isWithinWarrantyWindow(purchaseDate, settings.warrantyWindowDays);

  const claim = await prisma.warrantyClaims.create({
    data: {
      shopId: input.shopId,
      claimNumber: claimNumber(),
      shopifyCustomerId: input.shopifyCustomerId || null,
      customerName: String(input.customerName || "").trim() || null,
      customerEmail: email,
      customerPhone: String(input.customerPhone || "").trim() || null,
      companyName: String(input.companyName || "").trim() || null,
      productSku: sku.slice(0, 120),
      productTitle: String(input.productTitle || "").trim().slice(0, 200) || null,
      orderNumber: String(input.orderNumber || "").trim().slice(0, 80) || null,
      purchaseDate,
      issueDescription: issue.slice(0, 5000),
      attachmentUrls: Array.isArray(input.attachmentUrls)
        ? input.attachmentUrls.slice(0, 10)
        : [],
      withinWarrantyWindow: within,
      idempotencyKey: input.idempotencyKey,
      reviewHistory: [
        {
          at: new Date().toISOString(),
          actor: "storefront",
          action: "submitted",
          note: within === false ? "Submitted outside configured warranty window" : null,
        },
      ],
    },
  });

  return { claim, duplicate: false, successMessage: settings.successMessage };
}
