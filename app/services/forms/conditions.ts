import type { ConditionClause, ConditionGroup, FormFieldBase, FormSchema } from "./field-registry";

function isEmpty(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

function clauseMatches(clause: ConditionClause, answers: Record<string, unknown>): boolean {
  const raw = answers[clause.fieldId];
  switch (clause.operator) {
    case "equals":
      return String(raw ?? "") === String(clause.value ?? "");
    case "not_equals":
      return String(raw ?? "") !== String(clause.value ?? "");
    case "contains":
      return String(raw ?? "").toLowerCase().includes(String(clause.value ?? "").toLowerCase());
    case "not_empty":
      return !isEmpty(raw);
    case "empty":
      return isEmpty(raw);
    case "in": {
      const list = Array.isArray(clause.value) ? clause.value.map(String) : [String(clause.value)];
      if (Array.isArray(raw)) return raw.map(String).some((v) => list.includes(v));
      return list.includes(String(raw ?? ""));
    }
    case "not_in": {
      const list = Array.isArray(clause.value) ? clause.value.map(String) : [String(clause.value)];
      if (Array.isArray(raw)) return !raw.map(String).some((v) => list.includes(v));
      return !list.includes(String(raw ?? ""));
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = Number(raw);
      const b = Number(clause.value);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      if (clause.operator === "gt") return a > b;
      if (clause.operator === "gte") return a >= b;
      if (clause.operator === "lt") return a < b;
      return a <= b;
    }
    default:
      return false;
  }
}

export function evaluateConditionGroup(
  group: ConditionGroup | null | undefined,
  answers: Record<string, unknown>,
): boolean {
  if (!group || !group.clauses?.length) return true;
  if (group.logic === "OR") {
    return group.clauses.some((c) => clauseMatches(c, answers));
  }
  return group.clauses.every((c) => clauseMatches(c, answers));
}

export function isFieldVisible(field: FormFieldBase, answers: Record<string, unknown>): boolean {
  return evaluateConditionGroup(field.visibility ?? null, answers);
}

export function isFieldRequired(field: FormFieldBase, answers: Record<string, unknown>): boolean {
  if (!isFieldVisible(field, answers)) return false;
  if (field.required) return true;
  if (field.requiredWhen) return evaluateConditionGroup(field.requiredWhen, answers);
  return false;
}

/** Strip answers for hidden fields so stale values never leak into storage. */
export function sanitizeAnswersForVisibility(
  schema: FormSchema,
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Iterate until stable — visibility can depend on other answers (no cycles across fields themselves)
  let current = { ...answers };
  for (let pass = 0; pass < 5; pass++) {
    const next: Record<string, unknown> = {};
    for (const field of schema.fields) {
      if (field.presentational) continue;
      if (isFieldVisible(field, current) && field.id in current) {
        next[field.id] = current[field.id];
      }
    }
    const same =
      Object.keys(next).length === Object.keys(out).length &&
      Object.keys(next).every((k) => next[k] === out[k]);
    Object.assign(out, next);
    current = next;
    if (same && pass > 0) break;
  }
  return out;
}

export type ConditionIssue = {
  fieldId: string;
  message: string;
};

export function validateConditionReferences(schema: FormSchema): ConditionIssue[] {
  const ids = new Set(schema.fields.map((f) => f.id));
  const issues: ConditionIssue[] = [];

  const checkGroup = (fieldId: string, group: ConditionGroup | null | undefined, kind: string) => {
    if (!group) return;
    for (const clause of group.clauses || []) {
      if (!ids.has(clause.fieldId)) {
        issues.push({
          fieldId,
          message: `${kind} references missing field ${clause.fieldId}`,
        });
      }
      if (clause.fieldId === fieldId) {
        issues.push({
          fieldId,
          message: `${kind} cannot reference the same field`,
        });
      }
    }
  };

  for (const field of schema.fields) {
    checkGroup(field.id, field.visibility, "Visibility");
    checkGroup(field.id, field.requiredWhen, "Required-when");
  }

  // Detect simple cycles in visibility dependency graph
  const deps = new Map<string, string[]>();
  for (const field of schema.fields) {
    const refs = [
      ...(field.visibility?.clauses.map((c) => c.fieldId) ?? []),
      ...(field.requiredWhen?.clauses.map((c) => c.fieldId) ?? []),
    ];
    deps.set(field.id, refs);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string, stack: string[]) => {
    if (visiting.has(id)) {
      issues.push({
        fieldId: id,
        message: `Circular condition reference: ${[...stack, id].join(" → ")}`,
      });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of deps.get(id) || []) walk(next, [...stack, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of deps.keys()) walk(id, []);

  return issues;
}

export function findFieldsReferencing(schema: FormSchema, targetFieldId: string): string[] {
  const hit: string[] = [];
  for (const field of schema.fields) {
    const refs = [
      ...(field.visibility?.clauses.map((c) => c.fieldId) ?? []),
      ...(field.requiredWhen?.clauses.map((c) => c.fieldId) ?? []),
    ];
    if (refs.includes(targetFieldId)) hit.push(field.id);
  }
  for (const [mapping, fieldId] of Object.entries(schema.businessMappings || {})) {
    if (fieldId === targetFieldId) hit.push(`mapping:${mapping}`);
  }
  return hit;
}
