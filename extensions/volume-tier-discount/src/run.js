/**
 * Volume Tier Discount Function (JavaScript).
 *
 * Security:
 * - Discount % comes ONLY from the discount owner's trusted metafield map
 *   (tierId → discountBps), cross-checked against the customer's app metafield.
 * - Browser-provided tier names or percentages are never trusted.
 * - Missing/invalid config → no discount (fail safe).
 * - Logged-out carts have no customer metafield → no tier discount.
 *
 * Price basis: cart line selling price (subtotalAmount), NOT compare-at/MSRP.
 */

/**
 * @param {any} input
 */
export function run(input) {
  const empty = { operations: [] };

  const customer = input.cart?.buyerIdentity?.customer;
  if (!customer) return empty;

  const customerTier = customer.metafield?.jsonValue;
  const config = input.discount?.metafield?.jsonValue;
  if (!customerTier?.tierId || !config?.tiers) return empty;

  const authorizedBps = config.tiers[customerTier.tierId];
  if (authorizedBps == null || authorizedBps <= 0) return empty;

  const percent = (Number(authorizedBps) / 100).toFixed(2);
  if (Number(percent) <= 0) return empty;

  const targets = (input.cart.lines || [])
    .filter((line) => {
      const type = line.merchandise?.product?.productType?.toLowerCase?.() ?? "";
      return type !== "gift card";
    })
    .map((line) => ({ cartLine: { id: line.id } }));

  if (targets.length === 0) return empty;

  const message = `${config.messagePrefix ?? "Volume pricing"} (${percent}% off)`;

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates: [
            {
              message,
              targets,
              value: { percentage: { value: percent } },
            },
          ],
        },
      },
    ],
  };
}
