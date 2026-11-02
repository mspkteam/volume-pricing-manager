import type { PrismaClient, WarrantyClaims } from "@prisma/client";
import { ensureWarrantySettings } from "./settings";

type AdminGraphql = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

/**
 * Creates a Shopify draft order invoice for warranty shipping & handling.
 * Requires write_draft_orders scope on the app install.
 */
export async function createShippingHandlingInvoice(
  prisma: PrismaClient,
  admin: AdminGraphql,
  args: {
    shopId: string;
    shopDomain: string;
    claim: WarrantyClaims;
    amountMinorOverride?: number | null;
    recreate?: boolean;
  },
): Promise<{ draftOrderId: string; invoiceUrl: string | null; amountMinor: number }> {
  if (
    !args.recreate &&
    args.claim.shippingInvoiceDraftOrderId &&
    args.claim.shippingInvoiceUrl
  ) {
    return {
      draftOrderId: args.claim.shippingInvoiceDraftOrderId,
      invoiceUrl: args.claim.shippingInvoiceUrl,
      amountMinor: Number(args.claim.shippingAmountMinor || 0),
    };
  }

  const settings = await ensureWarrantySettings(prisma, args.shopId);
  const amountMinor =
    args.amountMinorOverride != null && args.amountMinorOverride >= 0
      ? Math.round(args.amountMinorOverride)
      : Number(settings.shippingHandlingMinor);

  const amount = (amountMinor / 100).toFixed(2);
  const title = `${settings.shippingHandlingTitle} (${args.claim.claimNumber})`;

  const mutation = `#graphql
    mutation WarrantyDraftOrder($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          invoiceUrl
          name
        }
        userErrors { field message }
      }
    }
  `;

  const input: Record<string, unknown> = {
    note: `Warranty claim ${args.claim.claimNumber} — SKU ${args.claim.productSku}`,
    email: args.claim.customerEmail,
    tags: ["warranty-claim", args.claim.claimNumber],
    customAttributes: [
      { key: "warranty_claim_id", value: args.claim.id },
      { key: "warranty_claim_number", value: args.claim.claimNumber },
      { key: "product_sku", value: args.claim.productSku },
    ],
    lineItems: [
      {
        title,
        originalUnitPrice: amount,
        quantity: 1,
        requiresShipping: false,
        taxable: false,
      },
    ],
  };

  if (args.claim.shopifyCustomerId) {
    const gid = args.claim.shopifyCustomerId.startsWith("gid://")
      ? args.claim.shopifyCustomerId
      : `gid://shopify/Customer/${args.claim.shopifyCustomerId}`;
    input.customerId = gid;
  }

  const res = await admin.graphql(mutation, { variables: { input } });
  const json = (await res.json()) as {
    data?: {
      draftOrderCreate?: {
        draftOrder?: { id: string; invoiceUrl?: string | null };
        userErrors?: { message: string }[];
      };
    };
    errors?: { message: string }[];
  };

  const errors = json.errors || json.data?.draftOrderCreate?.userErrors || [];
  if (errors.length) {
    const msg = errors.map((e) => e.message).join("; ");
    if (/access|scope|denied|unauthorized/i.test(msg)) {
      throw new Error(
        "Missing write_draft_orders permission. Reinstall/update app scopes, then try again.",
      );
    }
    throw new Error(msg || "Draft order create failed");
  }

  const draft = json.data?.draftOrderCreate?.draftOrder;
  if (!draft?.id) throw new Error("Draft order was not created");

  return {
    draftOrderId: draft.id,
    invoiceUrl: draft.invoiceUrl || null,
    amountMinor,
  };
}
