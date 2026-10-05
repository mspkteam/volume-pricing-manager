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
