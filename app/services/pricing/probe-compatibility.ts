/**
 * Live Admin probe for checkout Discount Function compatibility.
 * Storefront tag pricing does not depend on this probe.
 */

export type AppDistribution = "app_store" | "custom" | "unknown";

export type PricingProbeResult = {
  shopGid: string | null;
  planName: string | null;
  partnerDevelopment: boolean;
  shopifyPlus: boolean;
  distribution: AppDistribution;
  functionsAvailable: boolean;
  functionId: string | null;
  functionTitle: string | null;
  discountGid: string | null;
  isPlusEligible: boolean;
  error: string | null;
};

type AdminGraphql = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export function resolveAppDistribution(
  envValue?: string | null,
): AppDistribution {
  const v = (envValue || process.env.SHOPIFY_APP_DISTRIBUTION || "").toLowerCase();
  if (v === "app_store" || v === "public") return "app_store";
  if (v === "custom" || v === "partner") return "custom";
  // Partner CLI apps are custom by default
  return "custom";
}

export async function probePricingCompatibility(
  admin: AdminGraphql,
  distribution: AppDistribution = resolveAppDistribution(),
): Promise<PricingProbeResult> {
  const empty: PricingProbeResult = {
    shopGid: null,
    planName: null,
    partnerDevelopment: false,
    shopifyPlus: false,
    distribution,
    functionsAvailable: false,
    functionId: null,
    functionTitle: null,
    discountGid: null,
    isPlusEligible: false,
    error: null,
  };

  try {
    const res = await admin.graphql(
      `#graphql
      query VpmPricingProbe {
        shop {
          id
          plan {
            displayName
            partnerDevelopment
            shopifyPlus
          }
        }
        shopifyFunctions(first: 50) {
          nodes {
            id
            title
            apiType
            app { title }
          }
        }
        discountNodes(first: 25, query: "method:automatic") {
          nodes {
            id
            discount {
              ... on DiscountAutomaticApp {
                title
                status
                appDiscountType {
                  functionId
                  title
                }
              }
            }
          }
        }
      }`,
    );
    const json = await res.json();
    if (json?.errors?.length) {
      return {
        ...empty,
        error: json.errors.map((e: { message: string }) => e.message).join("; "),
      };
    }

    const shop = json?.data?.shop;
    const plan = shop?.plan;
    const planName = (plan?.displayName as string) || null;
    const partnerDevelopment = Boolean(plan?.partnerDevelopment);
    const shopifyPlus = Boolean(plan?.shopifyPlus);
    const isPlusEligible =
      shopifyPlus ||
      partnerDevelopment ||
      /plus|enterprise|partner/i.test(planName || "");

    const nodes = (json?.data?.shopifyFunctions?.nodes || []) as Array<{
      id?: string;
      title?: string;
      apiType?: string;
    }>;
    const functionsAvailable = nodes.length > 0;
    const match =
      nodes.find((n) => /volume|vpm|tier.?discount/i.test(n.title || "")) ||
      nodes.find((n) => /discount/i.test(n.apiType || "")) ||
      nodes[0] ||
      null;

    let discountGid: string | null = null;
    const discountNodes = (json?.data?.discountNodes?.nodes || []) as Array<{
      id?: string;
      discount?: {
        title?: string;
        appDiscountType?: { functionId?: string; title?: string };
      };
    }>;
    for (const node of discountNodes) {
      const title = node.discount?.title || "";
      const fnTitle = node.discount?.appDiscountType?.title || "";
      if (/volume|vpm|tier/i.test(title) || /volume|vpm|tier/i.test(fnTitle)) {
        discountGid = node.id || null;
        break;
      }
      if (
        match?.id &&
        node.discount?.appDiscountType?.functionId === match.id
      ) {
        discountGid = node.id || null;
        break;
      }
    }

    return {
      shopGid: (shop?.id as string) || null,
      planName,
      partnerDevelopment,
      shopifyPlus,
      distribution,
      functionsAvailable,
      functionId: match?.id || null,
      functionTitle: match?.title || null,
      discountGid,
      isPlusEligible,
      error: null,
    };
  } catch (err) {
    return {
      ...empty,
      error: err instanceof Error ? err.message : "Probe failed",
    };
  }
}

export async function createVolumeAutomaticDiscount(
  admin: AdminGraphql,
  functionId: string,
  title = "Volume Pricing Manager",
): Promise<{ discountGid: string | null; error: string | null }> {
  try {
    const startsAt = new Date().toISOString();
    const res = await admin.graphql(
      `#graphql
      mutation VpmCreateAutomaticDiscount($discount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $discount) {
          automaticAppDiscount { discountId }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          discount: {
            title,
            functionId,
            startsAt,
            combinesWith: {
              orderDiscounts: true,
              productDiscounts: true,
              shippingDiscounts: true,
            },
          },
        },
      },
    );
    const json = await res.json();
    const payload = json?.data?.discountAutomaticAppCreate;
    const errors = payload?.userErrors || [];
    if (errors.length) {
      return {
        discountGid: null,
        error: errors.map((e: { message: string }) => e.message).join("; "),
      };
    }
    return {
      discountGid: payload?.automaticAppDiscount?.discountId || null,
      error: null,
    };
  } catch (err) {
    return {
      discountGid: null,
      error: err instanceof Error ? err.message : "Create discount failed",
    };
  }
}

export function shopCheckoutWritesEnabled(
  pricingExternalIds: unknown,
  envWrites = process.env.PRICING_WRITES_ENABLED === "true",
): boolean {
  if (envWrites) return true;
  const ids = (pricingExternalIds || {}) as Record<string, unknown>;
  return ids.checkoutWritesEnabled === true || ids.checkoutWritesEnabled === "true";
}
