import { describe, expect, it } from "vitest";
import {
  validateSubmission,
  wholesalePublishRequirements,
} from "../app/services/forms/validate-submission";
import { emptyFormSchema, newFieldId, type FormSchema } from "../app/services/forms/field-registry";
import { contractorWholesaleTemplate } from "../app/services/forms/templates/contractor-wholesale";

describe("form validation", () => {
  it("requires visible required fields and validates email", () => {
    const emailId = newFieldId();
    const schema: FormSchema = emptyFormSchema({
      fields: [
        {
          id: emailId,
          type: "email",
          label: "Email",
          required: true,
          width: "full",
        },
      ],
    });
    const missing = validateSubmission(schema, {}, {
      currencyCode: "USD",
      tiers: [],
      uploadsConfigured: false,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors.some((e) => e.fieldId === emailId)).toBe(true);
    }

    const bad = validateSubmission(schema, { [emailId]: "not-an-email" }, {
      currencyCode: "USD",
      tiers: [],
      uploadsConfigured: false,
    });
    expect(bad.ok).toBe(false);

    const good = validateSubmission(schema, { [emailId]: "a@b.com" }, {
      currencyCode: "USD",
      tiers: [],
      uploadsConfigured: false,
    });
    expect(good.ok).toBe(true);
  });

  it("rejects stale schema cache keys", () => {
    const schema = emptyFormSchema();
    const result = validateSubmission(schema, {}, {
      currencyCode: "USD",
      tiers: [],
      uploadsConfigured: true,
      schemaCacheKey: "old",
      expectedCacheKey: "new",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.fieldId).toBe("_form");
    }
  });

  it("blocks file fields when uploads are not configured", () => {
    const fileId = newFieldId();
    const schema = emptyFormSchema({
      fields: [
        {
          id: fileId,
          type: "file_upload",
          label: "Docs",
          required: true,
          width: "full",
          settings: { maxFiles: 1 },
        },
      ],
    });
    const result = validateSubmission(schema, { [fileId]: ["upl_1"] }, {
      currencyCode: "USD",
      tiers: [],
      uploadsConfigured: false,
    });
    expect(result.ok).toBe(false);
  });
});

describe("wholesale publish requirements", () => {
  it("ignores GENERAL forms", () => {
    expect(wholesalePublishRequirements(emptyFormSchema({ purpose: "GENERAL" }))).toEqual([]);
  });

  it("requires core wholesale mappings", () => {
    const schema = emptyFormSchema({ purpose: "WHOLESALE" });
    const missing = wholesalePublishRequirements(schema);
    expect(missing).toContain("applicant_email");
    expect(missing).toContain("company_name");
    expect(missing).toContain("company_address");
  });

  it("passes when mappings are present", () => {
    const schema = emptyFormSchema({
      purpose: "WHOLESALE",
      businessMappings: {
        applicant_email: "e1",
        company_name: "c1",
        company_address: "a1",
      },
    });
    expect(wholesalePublishRequirements(schema)).toEqual([]);
  });
});

describe("contractor wholesale template", () => {
  it("is an editable WHOLESALE schema with expected structure", () => {
    const schema = contractorWholesaleTemplate();
    expect(schema.version).toBe(1);
    expect(schema.purpose).toBe("WHOLESALE");
    expect(schema.requireLogin).toBe(true);
    expect(schema.fields.length).toBeGreaterThan(5);
    expect(schema.businessMappings.applicant_email).toBeTruthy();
    expect(schema.businessMappings.company_name).toBeTruthy();
    expect(schema.businessMappings.company_address).toBeTruthy();
    expect(schema.fields.some((f) => f.type === "tier_select")).toBe(true);
    expect(schema.fields.some((f) => f.type === "file_upload")).toBe(true);
    expect(schema.fields.some((f) => f.type === "consent")).toBe(true);
    expect(wholesalePublishRequirements(schema)).toEqual([]);
  });
});
