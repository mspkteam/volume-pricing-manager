import type { PrismaClient, WarrantySettings } from "@prisma/client";

export type WarrantySettingsView = {
  warrantyWindowDays: number;
  shippingHandlingMinor: number;
  shippingHandlingTitle: string;
  requireLogin: boolean;
  requireOrderNumber: boolean;
  requirePurchaseDate: boolean;
  successMessage: string;
  introHtml: string;
};

export function toWarrantySettingsView(row: WarrantySettings): WarrantySettingsView {
  return {
    warrantyWindowDays: row.warrantyWindowDays,
    shippingHandlingMinor: Number(row.shippingHandlingMinor),
    shippingHandlingTitle: row.shippingHandlingTitle,
    requireLogin: row.requireLogin,
    requireOrderNumber: row.requireOrderNumber,
    requirePurchaseDate: row.requirePurchaseDate,
    successMessage: row.successMessage,
    introHtml: row.introHtml,
  };
}

export async function ensureWarrantySettings(
  prisma: PrismaClient,
  shopId: string,
): Promise<WarrantySettings> {
  const existing = await prisma.warrantySettings.findUnique({ where: { shopId } });
  if (existing) return existing;
  return prisma.warrantySettings.create({
    data: { shopId },
  });
}

export async function updateWarrantySettings(
  prisma: PrismaClient,
  shopId: string,
  patch: Partial<WarrantySettingsView>,
): Promise<WarrantySettings> {
  await ensureWarrantySettings(prisma, shopId);
  return prisma.warrantySettings.update({
    where: { shopId },
    data: {
      ...(patch.warrantyWindowDays != null
        ? { warrantyWindowDays: Math.max(0, Math.floor(patch.warrantyWindowDays)) }
        : {}),
      ...(patch.shippingHandlingMinor != null
        ? {
            shippingHandlingMinor: BigInt(
              Math.max(0, Math.round(patch.shippingHandlingMinor)),
            ),
          }
        : {}),
      ...(patch.shippingHandlingTitle != null
        ? { shippingHandlingTitle: String(patch.shippingHandlingTitle).slice(0, 200) }
        : {}),
      ...(patch.requireLogin != null ? { requireLogin: Boolean(patch.requireLogin) } : {}),
      ...(patch.requireOrderNumber != null
        ? { requireOrderNumber: Boolean(patch.requireOrderNumber) }
        : {}),
      ...(patch.requirePurchaseDate != null
        ? { requirePurchaseDate: Boolean(patch.requirePurchaseDate) }
        : {}),
      ...(patch.successMessage != null
        ? { successMessage: String(patch.successMessage).slice(0, 500) }
        : {}),
      ...(patch.introHtml != null ? { introHtml: String(patch.introHtml).slice(0, 5000) } : {}),
    },
  });
}

export function isWithinWarrantyWindow(
  purchaseDate: Date | null | undefined,
  windowDays: number,
  now = new Date(),
): boolean | null {
  if (!purchaseDate) return null;
  if (windowDays <= 0) return true;
  const end = new Date(purchaseDate);
  end.setUTCDate(end.getUTCDate() + windowDays);
  return now.getTime() <= end.getTime();
}
