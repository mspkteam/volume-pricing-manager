import type { FormFieldBase, FormSchema } from "./field-registry";
import { FORM_TECHNICAL_LIMITS, FIELD_REGISTRY } from "./field-registry";
import {
  isFieldRequired,
  isFieldVisible,
  sanitizeAnswersForVisibility,
  validateConditionReferences,
} from "./conditions";
import { formatMoney } from "../../lib/money";

export type TierOption = {
  id: string;
  name: string;
  minSpendMinor: bigint | number | string;
  isActive: boolean;
  isArchived: boolean;
};

export type ValidationError = { fieldId: string; message: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const URL_RE = /^https?:\/\/.+/i;

function asString(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function validateAddress(value: unknown, field: FormFieldBase): string | null {
  if (!value || typeof value !== "object") return "Address is required";
  const a = value as Record<string, string>;
  if (!asString(a.line1)) return "Street address is required";
  if (!asString(a.city)) return "City is required";
  const requireCountry = field.settings?.requireCountry !== false;
  const requirePostal = field.settings?.requirePostal !== false;
  if (requireCountry && !asString(a.country)) return "Country is required";
  if (requirePostal && !asString(a.postal)) return "Postal / ZIP is required";
  return null;
}

function validateOne(
  field: FormFieldBase,
  value: unknown,
  ctx: {
    currencyCode: string;
    tiers: TierOption[];
    uploadsConfigured: boolean;
  },
): string | null {
  const v = field.validation || {};
  switch (field.type) {
    case "short_text":
    case "long_text":
    case "phone": {
      const s = asString(value);
      if (!s) return null;
      const max = Number(v.maxLength ?? FORM_TECHNICAL_LIMITS.maxTextLength);
      if (s.length > max) return `Must be at most ${max} characters`;
      const min = Number(v.minLength ?? 0);
      if (s.length < min) return `Must be at least ${min} characters`;
      return null;
    }
    case "email": {
      const s = asString(value);
      if (!s) return null;
      if (!EMAIL_RE.test(s)) return "Enter a valid email address";
      return null;
    }
    case "url": {
      const s = asString(value);
      if (!s) return null;
      if (!URL_RE.test(s)) return "Enter a valid URL starting with http:// or https://";
      return null;
    }
    case "number":
    case "currency": {
      if (value === "" || value == null) return null;
      const n = Number(value);
      if (Number.isNaN(n)) return "Enter a valid number";
      if (v.min != null && n < Number(v.min)) return `Must be at least ${v.min}`;
      if (v.max != null && n > Number(v.max)) return `Must be at most ${v.max}`;
      return null;
    }
    case "date": {
      const s = asString(value);
      if (!s) return null;
      if (Number.isNaN(Date.parse(s))) return "Enter a valid date";
      return null;
    }
    case "dropdown":
    case "radio": {
      const s = asString(value);
      if (!s) return null;
      const allowed = (field.options || []).map((o) => o.value);
      if (!allowed.includes(s)) return "Select a valid option";
      return null;
    }
    case "multi_select":
    case "checkbox_group": {
      if (value == null || value === "") return null;
      const arr = Array.isArray(value) ? value.map(String) : [String(value)];
      const allowed = new Set((field.options || []).map((o) => o.value));
      if (arr.some((x) => !allowed.has(x))) return "Contains an invalid option";
      return null;
    }
    case "checkbox":
    case "consent": {
      if (value === true || value === "true" || value === "on" || value === 1) return null;
      return null;
    }
    case "address":
      return validateAddress(value, field);
    case "country": {
      const s = asString(value);
      if (!s) return null;
      if (s.length < 2) return "Select a valid country";
      return null;
    }
    case "file_upload": {
      if (!ctx.uploadsConfigured) {
        return "File uploads are not configured for this shop";
      }
      if (value == null || value === "") return null;
      const refs = Array.isArray(value) ? value : [value];
      const maxFiles = Number(field.settings?.maxFiles ?? 1);
      if (refs.length > maxFiles) return `Upload at most ${maxFiles} file(s)`;
      return null;
    }
    case "tier_select": {
      const s = asString(value);
      if (!s) return null;
      const available = (field.settings?.availableTierIds as string[] | undefined) || [];
      const tier = ctx.tiers.find((t) => t.id === s);
      if (!tier || tier.isArchived || !tier.isActive) {
        return "Selected tier is no longer available — refresh the form and try again";
      }
      if (available.length && !available.includes(s)) {
        return "Selected tier is not available on this form — refresh and try again";
      }
      return null;
    }
    default:
      return null;
  }
}

export function validateSubmission(
  schema: FormSchema,
  rawAnswers: Record<string, unknown>,
  ctx: {
    currencyCode: string;
    tiers: TierOption[];
    uploadsConfigured: boolean;
    schemaCacheKey?: string;
    expectedCacheKey?: string;
  },
): { ok: true; answers: Record<string, unknown> } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (ctx.expectedCacheKey && ctx.schemaCacheKey && ctx.expectedCacheKey !== ctx.schemaCacheKey) {
    return {
      ok: false,
      errors: [
        {
          fieldId: "_form",
          message: "This form was updated. Refresh the page and submit again.",
        },
      ],
    };
  }

  const conditionIssues = validateConditionReferences(schema);
  if (conditionIssues.length) {
    errors.push({
      fieldId: "_form",
      message: "Form configuration is invalid. Contact the merchant.",
    });
  }

  const answers = sanitizeAnswersForVisibility(schema, rawAnswers);

  for (const field of schema.fields) {
    if (field.presentational) continue;
    if (!FIELD_REGISTRY[field.type]) {
      errors.push({ fieldId: field.id, message: "Unsupported field type" });
      continue;
    }
    if (!isFieldVisible(field, answers)) continue;

    const value = answers[field.id];
    const required = isFieldRequired(field, answers);
    if (required) {
      if (field.type === "checkbox" || field.type === "consent") {
        if (!(value === true || value === "true" || value === "on")) {
          errors.push({ fieldId: field.id, message: `${field.label} is required` });
          continue;
        }
      } else if (
        value == null ||
        value === "" ||
        (Array.isArray(value) && value.length === 0)
      ) {
        errors.push({ fieldId: field.id, message: `${field.label} is required` });
        continue;
      }
    }

    const err = validateOne(field, value, ctx);
    if (err) errors.push({ fieldId: field.id, message: err });
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, answers };
}

export function buildTierDisplayOptions(
  field: FormFieldBase,
  tiers: TierOption[],
  currencyCode: string,
): Array<{ id: string; label: string; name: string; rangeLabel: string }> {
  const available = (field.settings?.availableTierIds as string[] | undefined) || [];
  const mode = String(field.settings?.displayMode || "both");
  const sorted = [...tiers]
    .filter((t) => t.isActive && !t.isArchived)
    .filter((t) => !available.length || available.includes(t.id))
    .sort((a, b) => Number(a.minSpendMinor) - Number(b.minSpendMinor));

  return sorted.map((t, i) => {
    const min = formatMoney(BigInt(t.minSpendMinor), currencyCode);
    const next = sorted[i + 1];
    const rangeLabel = next
      ? `${min} – under ${formatMoney(BigInt(next.minSpendMinor), currencyCode)}`
      : `${min}+`;
    let label = t.name;
    if (mode === "ranges") label = rangeLabel;
    else if (mode === "both") label = `${t.name} (${rangeLabel})`;
    return { id: t.id, label, name: t.name, rangeLabel };
  });
}

export function wholesalePublishRequirements(schema: FormSchema): string[] {
  if (schema.purpose !== "WHOLESALE") return [];
  const missing: string[] = [];
  const required: Array<keyof FormSchema["businessMappings"]> = [
    "applicant_email",
    "company_name",
    "company_address",
  ];
  for (const key of required) {
    if (!schema.businessMappings[key]) missing.push(key);
  }
  return missing;
}
