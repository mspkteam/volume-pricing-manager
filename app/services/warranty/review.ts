import type { PrismaClient, WarrantyClaimStatus, WarrantyClaims } from "@prisma/client";
import { createShippingHandlingInvoice } from "./invoice";

type AdminGraphql = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type ReviewWarrantyAction =
  | "approve"
  | "reject"
  | "needs_information"
  | "close"
  | "send_shipping_invoice";

function appendHistory(
  existing: unknown,
  entry: { at: string; actor: string; action: string; note?: string | null },
) {
  const list = Array.isArray(existing) ? [...existing] : [];
  list.push(entry);
  return list.slice(-50);
}

export async function reviewWarrantyClaim(
  prisma: PrismaClient,
  args: {
    shopId: string;
    shopDomain: string;
    claimId: string;
    action: ReviewWarrantyAction;
    actor: string;
    customerMessage?: string;
    internalNotes?: string;
    admin?: AdminGraphql;
    shippingAmountMinorOverride?: number | null;
  },
): Promise<{ claim: WarrantyClaims; invoiceWarning?: string }> {
  const claim = await prisma.warrantyClaims.findFirst({
    where: { id: args.claimId, shopId: args.shopId },
  });
  if (!claim) throw new Error("Claim not found");

  const statusMap: Record<Exclude<ReviewWarrantyAction, "send_shipping_invoice">, WarrantyClaimStatus> = {
    approve: "APPROVED",
    reject: "REJECTED",
    needs_information: "NEEDS_INFORMATION",
    close: "CLOSED",
  };

  let nextStatus: WarrantyClaimStatus =
    args.action === "send_shipping_invoice" ? claim.status : statusMap[args.action];
  let shippingInvoiceDraftOrderId = claim.shippingInvoiceDraftOrderId;
  let shippingInvoiceUrl = claim.shippingInvoiceUrl;
  let shippingAmountMinor = claim.shippingAmountMinor;
  let invoiceWarning: string | undefined;

  if (args.action === "send_shipping_invoice") {
    if (!args.admin) {
      throw new Error("Admin API required to create shipping invoice");
    }
    try {
      const invoice = await createShippingHandlingInvoice(prisma, args.admin, {
        shopId: args.shopId,
        shopDomain: args.shopDomain,
        claim,
        amountMinorOverride: args.shippingAmountMinorOverride,
      });
      shippingInvoiceDraftOrderId = invoice.draftOrderId;
      shippingInvoiceUrl = invoice.invoiceUrl;
      shippingAmountMinor = BigInt(invoice.amountMinor);
      nextStatus = "INVOICE_SENT";
    } catch (err) {
      invoiceWarning =
        err instanceof Error ? err.message : "Could not create shipping invoice";
      throw err;
    }
  }

  const updated = await prisma.warrantyClaims.update({
    where: { id: claim.id },
    data: {
      status: nextStatus,
      customerMessage: args.customerMessage ?? claim.customerMessage,
      internalNotes:
        args.internalNotes != null ? String(args.internalNotes) : claim.internalNotes,
      shippingInvoiceDraftOrderId,
      shippingInvoiceUrl,
      shippingAmountMinor,
      reviewedAt: new Date(),
      reviewedBy: args.actor,
      reviewHistory: appendHistory(claim.reviewHistory, {
        at: new Date().toISOString(),
        actor: args.actor,
        action: args.action,
        note: invoiceWarning || args.customerMessage || null,
      }),
    },
  });

  return { claim: updated, invoiceWarning };
}
