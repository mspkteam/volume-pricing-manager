/**
 * Extensible form field system — structured config only (no merchant JS/HTML execution).
 */

export const FORM_TECHNICAL_LIMITS = {
  maxFieldsPerForm: 200,
  maxSteps: 20,
  maxOptionsPerField: 100,
  maxConditionRules: 100,
  maxTextLength: 10_000,
  maxFileBytes: 10 * 1024 * 1024,
  maxFilesPerField: 5,
  maxUploadFields: 20,
} as const;

export type FieldWidth = "full" | "half" | "third";

export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_empty"
  | "empty"
  | "in"
  | "not_in"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

export type ConditionClause = {
  fieldId: string;
  operator: ConditionOperator;
  value?: unknown;
};

export type ConditionGroup = {
  logic: "AND" | "OR";
  clauses: ConditionClause[];
};

export type FieldOption = { value: string; label: string };

export type BusinessMappingKey =
  | "applicant_name"
  | "applicant_email"
  | "applicant_phone"
  | "company_name"
  | "company_website"
  | "company_address"
  | "expected_volume"
  | "requested_tier"
  | "license_document"
  | "resale_document"
  | "contractor_document"
  | "terms_consent"
  | "privacy_consent";

export type FormFieldType =
  | "short_text"
  | "long_text"
  | "email"
  | "phone"
  | "number"
  | "currency"
  | "date"
  | "dropdown"
  | "multi_select"
  | "radio"
  | "checkbox"
  | "checkbox_group"
  | "address"
  | "country"
  | "url"
  | "file_upload"
  | "consent"
  | "tier_select"
  | "heading"
  | "paragraph"
  | "divider"
  | "section"
  | "step_break";

export type FormFieldBase = {
  id: string;
  type: FormFieldType;
  label: string;
  description?: string;
  placeholder?: string;
  helperText?: string;
  required?: boolean;
  width?: FieldWidth;
  defaultValue?: unknown;
  /** Show when condition matches; omit = always visible */
  visibility?: ConditionGroup | null;
  /** Become required when condition matches */
  requiredWhen?: ConditionGroup | null;
  validation?: Record<string, unknown>;
  options?: FieldOption[];
  settings?: Record<string, unknown>;
  /** Layout-only fields are not submitted as answers */
  presentational?: boolean;
};

export type FormSchema = {
  version: 1;
  title: string;
  description: string;
  purpose: "GENERAL" | "WHOLESALE";
  requireLogin: boolean;
  fields: FormFieldBase[];
  /** fieldId → business mapping */
  businessMappings: Partial<Record<BusinessMappingKey, string>>;
  settings: {
    submitLabel?: string;
    successMessage?: string;
    allowGuest?: boolean;
  };
};

export type FieldTypeDefinition = {
  type: FormFieldType;
  label: string;
  category: "input" | "choice" | "media" | "layout" | "commerce";
  presentational: boolean;
  supportsOptions: boolean;
  supportsConditions: boolean;
  defaultLabel: string;
  createDefault: (id: string) => FormFieldBase;
  /** Soft validate field config in builder */
  validateConfig?: (field: FormFieldBase) => string[];
};

function base(
  id: string,
  type: FormFieldType,
  label: string,
  extras: Partial<FormFieldBase> = {},
): FormFieldBase {
  return {
    id,
    type,
    label,
    required: false,
    width: "full",
    presentational: false,
    ...extras,
  };
}

export const FIELD_REGISTRY: Record<FormFieldType, FieldTypeDefinition> = {
  short_text: {
    type: "short_text",
    label: "Short text",
    category: "input",
    presentational: false,
    supportsOptions: false,
    supportsConditions: true,
    defaultLabel: "Short text",
    createDefault: (id) => base(id, "short_text", "Short text", { validation: { maxLength: 200 } }),
  },
  long_text: {
    type: "long_text",
    label: "Long text",
    category: "input",
    presentational: false,
    supportsOptions: false,
    supportsConditions: true,
    defaultLabel: "Long text",
    createDefault: (id) => base(id, "long_text", "Long text", { validation: { maxLength: 5000 } }),
  },
  email: {
    type: "email",
    label: "Email",
    category: "input",
    presentational: false,
    supportsOptions: false,
    supportsConditions: true,
    defaultLabel: "Email",
    createDefault: (id) => base(id, "email", "Email", { required: true }),
  },
  phone: {
    type: "phone",
    label: "Phone",
    category: "input",
    presentational: false,
    supportsOptions: false,
    supportsConditions: true,
    defaultLabel: "Phone",
    createDefault: (id) => base(id, "phone", "Phone"),
  },
  number: {
    type: "number",
    label: "Number",
    category: "input",
    presentational: false,
    supportsOptions: false,
    supportsConditions: true,
    defaultLabel: "Number",
    createDefault: (id) => base(id, "number", "Number"),
  },
  currency: {
    type: "currency",
    label: "Currency amount",
    category: "input",
    presentational: false,
    supportsOptions: false,
    supportsConditions: true,
    defaultLabel: "Amount",
    createDefault: (id) => base(id, "currency", "Amount"),
  },
  date: {
    type: "date",
    label: "Date",
    category: "input",
    presentational: false,
    supportsOptions: false,
    supportsConditions: true,
    defaultLabel: "Date",
    createDefault: (id) => base(id, "date", "Date"),
  },
  dropdown: {
    type: "dropdown",
    label: "Dropdown",
    category: "choice",
    presentational: false,
    supportsOptions: true,
    supportsConditions: true,
    defaultLabel: "Select an option",
    createDefault: (id) =>
      base(id, "dropdown", "Select an option", {
        options: [
          { value: "option_a", label: "Option A" },
          { value: "option_b", label: "Option B" },
        ],
      }),
  },
  multi_select: {
    type: "multi_select",
    label: "Multiple-choice",
    category: "choice",
    presentational: false,
    supportsOptions: true,
    supportsConditions: true,
    defaultLabel: "Select options",
    createDefault: (id) =>
      base(id, "multi_select", "Select options", {
        options: [
          { value: "option_a", label: "Option A" },
          { value: "option_b", label: "Option B" },
        ],
      }),
  },
  radio: {
    type: "radio",
    label: "Radio buttons",
    category: "choice",
    presentational: false,
    supportsOptions: true,
    supportsConditions: true,
    defaultLabel: "Choose one",
    createDefault: (id) =>
      base(id, "radio", "Choose one", {
        options: [
          { value: "option_a", label: "Option A" },
          { value: "option_b", label: "Option B" },
        ],
      }),
  },
  checkbox: {
    type: "checkbox",
    label: "Single checkbox",
    category: "choice",
    presentational: false,
    supportsOptions: false,
    supportsConditions: true,
    defaultLabel: "I agree",
    createDefault: (id) => base(id, "checkbox", "I agree"),
  },
  checkbox_group: {
    type: "checkbox_group",
    label: "Checkbox group",
    category: "choice",
    presentational: false,
    supportsOptions: true,
    supportsConditions: true,
    defaultLabel: "Select all that apply",
    createDefault: (id) =>
      base(id, "checkbox_group", "Select all that apply", {
        options: [
          { value: "option_a", label: "Option A" },
          { value: "option_b", label: "Option B" },
        ],
      }),
  },
  address: {
    type: "address",
    label: "Address",
    category: "input",
    presentational: false,
    supportsOptions: false,
    supportsConditions: true,
    defaultLabel: "Address",
    createDefault: (id) =>
      base(id, "address", "Address", {
        settings: { requireCountry: true, requirePostal: true },
      }),
  },
  country: {
    type: "country",
    label: "Country selector",
    category: "input",
    presentational: false,
    supportsOptions: false,
    supportsConditions: true,
    defaultLabel: "Country",
    createDefault: (id) => base(id, "country", "Country"),
  },
  url: {
    type: "url",
    label: "Website URL",
    category: "input",
    presentational: false,
    supportsOptions: false,
    supportsConditions: true,
    defaultLabel: "Website",
    createDefault: (id) => base(id, "url", "Website"),
  },
  file_upload: {
    type: "file_upload",
    label: "File upload",
    category: "media",
    presentational: false,
    supportsOptions: false,
    supportsConditions: true,
    defaultLabel: "Upload file",
    createDefault: (id) =>
      base(id, "file_upload", "Upload file", {
        settings: {
          accept: ["application/pdf", "image/jpeg", "image/png"],
          maxBytes: FORM_TECHNICAL_LIMITS.maxFileBytes,
          maxFiles: 1,
        },
      }),
  },
  consent: {
    type: "consent",
    label: "Terms / policy consent",
    category: "choice",
    presentational: false,
    supportsOptions: false,
    supportsConditions: true,
    defaultLabel: "I agree to the terms",
    createDefault: (id) =>
      base(id, "consent", "I agree to the terms", {
        required: true,
        settings: { policyUrl: "", policyLabel: "Terms and Privacy Policy" },
      }),
  },
  tier_select: {
    type: "tier_select",
    label: "Pricing tier / volume",
    category: "commerce",
    presentational: false,
    supportsOptions: false,
    supportsConditions: true,
    defaultLabel: "Expected purchase volume",
    createDefault: (id) =>
      base(id, "tier_select", "Expected purchase volume", {
        required: true,
        helperText:
          "Expected volume is used for review and does not automatically grant a discount.",
        settings: {
          availableTierIds: [] as string[],
          displayMode: "both",
        },
      }),
  },
  heading: {
    type: "heading",
    label: "Heading",
    category: "layout",
    presentational: true,
    supportsOptions: false,
    supportsConditions: true,
    defaultLabel: "Section heading",
    createDefault: (id) =>
      base(id, "heading", "Section heading", { presentational: true, settings: { level: 2 } }),
  },
  paragraph: {
    type: "paragraph",
    label: "Paragraph",
    category: "layout",
    presentational: true,
    supportsOptions: false,
    supportsConditions: true,
    defaultLabel: "Supporting text",
    createDefault: (id) =>
      base(id, "paragraph", "Supporting text", { presentational: true }),
  },
  divider: {
    type: "divider",
    label: "Divider",
    category: "layout",
    presentational: true,
    supportsOptions: false,
    supportsConditions: false,
    defaultLabel: "Divider",
    createDefault: (id) => base(id, "divider", "Divider", { presentational: true }),
  },
  section: {
    type: "section",
    label: "Section",
    category: "layout",
    presentational: true,
    supportsOptions: false,
    supportsConditions: true,
    defaultLabel: "New section",
    createDefault: (id) =>
      base(id, "section", "New section", {
        presentational: true,
        description: "Section description",
      }),
  },
  step_break: {
    type: "step_break",
    label: "Step / page break",
    category: "layout",
    presentational: true,
    supportsOptions: false,
    supportsConditions: false,
    defaultLabel: "Next step",
    createDefault: (id) =>
      base(id, "step_break", "Next step", {
        presentational: true,
        settings: { stepTitle: "Next step" },
      }),
  },
};

export function listFieldTypes(): FieldTypeDefinition[] {
  return Object.values(FIELD_REGISTRY);
}

export function createField(type: FormFieldType, id: string): FormFieldBase {
  const def = FIELD_REGISTRY[type];
  if (!def) throw new Error(`Unknown field type: ${type}`);
  return def.createDefault(id);
}

export function emptyFormSchema(partial?: Partial<FormSchema>): FormSchema {
  return {
    version: 1,
    title: partial?.title ?? "Untitled form",
    description: partial?.description ?? "",
    purpose: partial?.purpose ?? "GENERAL",
    requireLogin: partial?.requireLogin ?? true,
    fields: partial?.fields ?? [],
    businessMappings: partial?.businessMappings ?? {},
    settings: {
      submitLabel: "Submit",
      successMessage: "Thank you — we received your application.",
      allowGuest: false,
      ...partial?.settings,
    },
  };
}

export function newFieldId(): string {
  return `fld_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
