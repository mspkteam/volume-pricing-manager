export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function formatChangeType(type: string): string {
  return type.replace(/_/g, " ").toLowerCase();
}

type AddressValue = {
  line1?: unknown;
  line2?: unknown;
  city?: unknown;
  region?: unknown;
  postal?: unknown;
  country?: unknown;
};

export type FormAnswerFormatOpts = {
  tiersById?: Record<string, { name: string; discountBps?: number }>;
  uploadsById?: Record<string, { originalFilename: string }>;
};

function formatAddress(value: AddressValue): string {
  const line1 = String(value.line1 || "").trim();
  const line2 = String(value.line2 || "").trim();
  const city = String(value.city || "").trim();
  const region = String(value.region || "").trim();
  const postal = String(value.postal || "").trim();
  const country = String(value.country || "").trim();
  const cityLine = [city, region].filter(Boolean).join(", ");
  const locality = [cityLine, postal].filter(Boolean).join(" ");
  return [line1, line2, locality, country].filter(Boolean).join("\n") || "—";
}

function resolveUploadLabel(
  id: string,
  uploadsById?: Record<string, { originalFilename: string }>,
): string {
  const hit = uploadsById?.[id];
  return hit?.originalFilename ? hit.originalFilename : id;
}

function resolveTierLabel(
  id: string,
  tiersById?: Record<string, { name: string; discountBps?: number }>,
): string {
  const hit = tiersById?.[id];
  if (!hit) return id;
  if (hit.discountBps != null) {
    return `${hit.name} (${(hit.discountBps / 100).toFixed(0)}% off)`;
  }
  return hit.name;
}

/** Human-readable form answer for admin review tables. */
export function formatFormAnswer(
  value: unknown,
  type?: string,
  opts: FormAnswerFormatOpts = {},
): string {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";

  if (type === "address" && typeof value === "object" && !Array.isArray(value)) {
    return formatAddress(value as AddressValue);
  }

  if (type === "tier_select") {
    return resolveTierLabel(String(value), opts.tiersById);
  }

  if (type === "file_upload") {
    const ids = Array.isArray(value) ? value.map(String) : [String(value)];
    return ids.map((id) => resolveUploadLabel(id, opts.uploadsById)).join(", ");
  }

  if (type === "consent" || type === "checkbox") {
    if (value === true || value === "true" || value === "on" || value === 1) return "Yes";
    if (value === false || value === "false" || value === 0) return "No";
  }

  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (typeof v === "object" && v) return formatFormAnswer(v, type, opts);
        return String(v);
      })
      .join(", ");
  }

  if (typeof value === "object") {
    // Fallback: if it looks like an address, format it even without type
    const obj = value as AddressValue;
    if (obj.line1 != null || obj.city != null || obj.country != null) {
      return formatAddress(obj);
    }
    return JSON.stringify(value, null, 2);
  }

  return String(value);
}
