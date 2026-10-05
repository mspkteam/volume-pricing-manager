import { describe, expect, it } from "vitest";
import {
  evaluateConditionGroup,
  isFieldRequired,
  isFieldVisible,
  sanitizeAnswersForVisibility,
  validateConditionReferences,
  findFieldsReferencing,
} from "../app/services/forms/conditions";
import type { FormFieldBase, FormSchema } from "../app/services/forms/field-registry";
import { emptyFormSchema, newFieldId } from "../app/services/forms/field-registry";

function field(partial: Partial<FormFieldBase> & Pick<FormFieldBase, "id" | "type" | "label">): FormFieldBase {
  return {
    required: false,
    width: "full",
    presentational: false,
    ...partial,
  };
}

describe("form conditions", () => {
  it("evaluates AND / OR groups", () => {
    const answers = { a: "yes", b: "no" };
    expect(
      evaluateConditionGroup(
        {
          logic: "AND",
          clauses: [
            { fieldId: "a", operator: "equals", value: "yes" },
            { fieldId: "b", operator: "equals", value: "no" },
          ],
        },
        answers,
      ),
    ).toBe(true);
    expect(
      evaluateConditionGroup(
        {
          logic: "OR",
          clauses: [
            { fieldId: "a", operator: "equals", value: "no" },
            { fieldId: "b", operator: "equals", value: "no" },
          ],
        },
        answers,
      ),
    ).toBe(true);
  });

  it("hides fields and strips stale answers", () => {
    const trigger = field({ id: "t1", type: "dropdown", label: "Type" });
    const dep = field({
      id: "d1",
      type: "short_text",
      label: "License #",
      visibility: {
        logic: "AND",
        clauses: [{ fieldId: "t1", operator: "equals", value: "contractor" }],
      },
    });
    const schema: FormSchema = emptyFormSchema({
      fields: [trigger, dep],
    });
    expect(isFieldVisible(dep, { t1: "reseller" })).toBe(false);
    expect(isFieldVisible(dep, { t1: "contractor" })).toBe(true);
    const cleaned = sanitizeAnswersForVisibility(schema, {
      t1: "reseller",
      d1: "ABC-123",
    });
    expect(cleaned.d1).toBeUndefined();
    expect(cleaned.t1).toBe("reseller");
  });

  it("applies requiredWhen only when visible", () => {
    const f = field({
      id: "x",
      type: "short_text",
      label: "Extra",
      requiredWhen: {
        logic: "AND",
        clauses: [{ fieldId: "flag", operator: "equals", value: "1" }],
      },
    });
    expect(isFieldRequired(f, { flag: "0" })).toBe(false);
    expect(isFieldRequired(f, { flag: "1" })).toBe(true);
  });

  it("flags missing and circular condition references", () => {
    const a = field({
      id: "a",
      type: "short_text",
      label: "A",
      visibility: {
        logic: "AND",
        clauses: [{ fieldId: "b", operator: "not_empty" }],
      },
    });
    const b = field({
      id: "b",
      type: "short_text",
      label: "B",
      visibility: {
        logic: "AND",
        clauses: [{ fieldId: "a", operator: "not_empty" }],
      },
    });
    const schema = emptyFormSchema({ fields: [a, b] });
    const issues = validateConditionReferences(schema);
    expect(issues.some((i) => /Circular/i.test(i.message))).toBe(true);

    const broken = emptyFormSchema({
      fields: [
        field({
          id: "c",
          type: "short_text",
          label: "C",
          visibility: {
            logic: "AND",
            clauses: [{ fieldId: "missing", operator: "equals", value: "x" }],
          },
        }),
      ],
    });
    expect(validateConditionReferences(broken).some((i) => /missing/i.test(i.message))).toBe(
      true,
    );
  });

  it("finds fields and mappings that reference a deleted id", () => {
    const id = newFieldId();
    const other = newFieldId();
    const schema = emptyFormSchema({
      fields: [
        field({ id, type: "short_text", label: "Name" }),
        field({
          id: other,
          type: "short_text",
          label: "Other",
          visibility: {
            logic: "AND",
            clauses: [{ fieldId: id, operator: "not_empty" }],
          },
        }),
      ],
      businessMappings: { applicant_name: id },
    });
    const refs = findFieldsReferencing(schema, id);
    expect(refs).toContain(other);
    expect(refs).toContain("mapping:applicant_name");
  });
});
