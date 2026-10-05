import type { FormSchema, FormFieldBase } from "./field-registry";
import { buildTierDisplayOptions, type TierOption } from "./validate-submission";
import { uploadsConfigured, uploadSetupMessage } from "../uploads/storage";

/** Public storefront schema — strips admin-only notes / internal mappings detail where needed. */
export function toStorefrontSchema(
  schema: FormSchema,
  args: {
    handle: string;
    cacheKey: string;
    publishedVersion: number;
    currencyCode: string;
    tiers: TierOption[];
  },
) {
  const uploadOk = uploadsConfigured();
  const fields = schema.fields.map((field) => serializeField(field, args.tiers, args.currencyCode, uploadOk));

  return {
    handle: args.handle,
    cacheKey: args.cacheKey,
    publishedVersion: args.publishedVersion,
    title: schema.title,
    description: schema.description,
    requireLogin: schema.requireLogin,
    allowGuest: Boolean(schema.settings.allowGuest) && !schema.requireLogin,
    currencyCode: args.currencyCode,
    submitLabel: schema.settings.submitLabel || "Submit",
    successMessage: schema.settings.successMessage || "Thank you.",
    uploadsAvailable: uploadOk,
    uploadSetupMessage: uploadOk ? null : uploadSetupMessage(),
    fields,
  };
}

function serializeField(
  field: FormFieldBase,
  tiers: TierOption[],
  currencyCode: string,
  uploadOk: boolean,
) {
  const base = {
    id: field.id,
    type: field.type,
    label: field.label,
    description: field.description || "",
    placeholder: field.placeholder || "",
    helperText: field.helperText || "",
    required: Boolean(field.required),
    width: field.width || "full",
    presentational: Boolean(field.presentational),
    visibility: field.visibility || null,
    requiredWhen: field.requiredWhen || null,
    options: field.options || [],
    defaultValue: field.defaultValue ?? null,
    validation: field.validation || {},
    settings: { ...(field.settings || {}) },
  };

  if (field.type === "tier_select") {
    return {
      ...base,
      tierOptions: buildTierDisplayOptions(field, tiers, currencyCode),
      helperText:
        field.helperText ||
        "Expected volume is used for review and does not automatically grant a discount.",
    };
  }
  if (field.type === "file_upload") {
    return {
      ...base,
      settings: {
        ...base.settings,
        uploadsAvailable: uploadOk,
      },
    };
  }
  return base;
}
