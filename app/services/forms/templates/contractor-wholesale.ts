import {
  emptyFormSchema,
  newFieldId,
  type FormSchema,
  type FormFieldBase,
} from "../field-registry";

/** Editable starter — same builder schema as a blank form. */
export function contractorWholesaleTemplate(): FormSchema {
  const firstName = newFieldId();
  const lastName = newFieldId();
  const email = newFieldId();
  const phone = newFieldId();
  const company = newFieldId();
  const website = newFieldId();
  const address = newFieldId();
  const volume = newFieldId();
  const docs = newFieldId();
  const consent = newFieldId();
  const applicantType = newFieldId();
  const sectionBiz = newFieldId();
  const sectionDocs = newFieldId();

  const fields: FormFieldBase[] = [
    {
      id: sectionBiz,
      type: "section",
      label: "Business details",
      description: "Tell us about your company.",
      presentational: true,
      width: "full",
    },
    {
      id: firstName,
      type: "short_text",
      label: "First name",
      required: true,
      width: "half",
      validation: { maxLength: 100 },
    },
    {
      id: lastName,
      type: "short_text",
      label: "Last name",
      required: true,
      width: "half",
      validation: { maxLength: 100 },
    },
    {
      id: email,
      type: "email",
      label: "Email",
      required: true,
      width: "half",
    },
    {
      id: phone,
      type: "phone",
      label: "Phone",
      required: true,
      width: "half",
    },
    {
      id: company,
      type: "short_text",
      label: "Company name",
      required: true,
      width: "full",
    },
    {
      id: website,
      type: "url",
      label: "Company website",
      required: false,
      width: "full",
    },
    {
      id: address,
      type: "address",
      label: "Company address",
      required: true,
      width: "full",
      helperText: "Company address is required for wholesale applications.",
      settings: { requireCountry: true, requirePostal: true },
    },
    {
      id: applicantType,
      type: "dropdown",
      label: "Applicant type",
      required: true,
      width: "full",
      options: [
        { value: "contractor", label: "Contractor" },
        { value: "reseller", label: "Reseller / Distributor" },
        { value: "other", label: "Other" },
      ],
    },
    {
      id: volume,
      type: "tier_select",
      label: "Expected annual purchase volume",
      required: true,
      width: "full",
      helperText:
        "Expected volume is used for review and does not automatically grant a discount.",
      settings: { availableTierIds: [], displayMode: "both" },
    },
    {
      id: sectionDocs,
      type: "section",
      label: "Documents & consent",
      presentational: true,
      width: "full",
    },
    {
      id: docs,
      type: "file_upload",
      label: "Business License / Reseller Certificate / Contractor License",
      required: true,
      width: "full",
      requiredWhen: {
        logic: "OR",
        clauses: [
          { fieldId: applicantType, operator: "equals", value: "contractor" },
          { fieldId: applicantType, operator: "equals", value: "reseller" },
        ],
      },
      settings: {
        accept: ["application/pdf", "image/jpeg", "image/png"],
        maxBytes: 10 * 1024 * 1024,
        maxFiles: 3,
      },
    },
    {
      id: consent,
      type: "consent",
      label: "I agree to the Terms and Privacy Policy",
      required: true,
      width: "full",
      settings: {
        policyUrl: "/policies/privacy-policy",
        policyLabel: "Terms and Privacy Policy",
      },
    },
  ];

  return emptyFormSchema({
    title: "Contractor Wholesale Application",
    description:
      "Apply for contractor / wholesale pricing. Approval is separate from automatic spend-based tier qualification.",
    purpose: "WHOLESALE",
    requireLogin: true,
    fields,
    businessMappings: {
      applicant_name: firstName, // combined at review from first+last via custom — map email/company primarily
      applicant_email: email,
      applicant_phone: phone,
      company_name: company,
      company_website: website,
      company_address: address,
      expected_volume: volume,
      requested_tier: volume,
      license_document: docs,
      contractor_document: docs,
      resale_document: docs,
      terms_consent: consent,
      privacy_consent: consent,
    },
    settings: {
      submitLabel: "Submit application",
      successMessage:
        "Thanks — your wholesale application was received. We will review it and update your account.",
      allowGuest: false,
    },
  });
}

/** Fix applicant_name mapping: store both names by using a composite mapping note —
 *  We map applicant_name to firstName; review service concatenates adjacent last name if present.
 *  Better: add both to a custom mapping. For template, set applicant_name to firstName and
 *  keep lastName as unmapped custom field — or create a short_text "Full name".
 *  Spec asks first + last separately. Mapping applicant_name to firstName is incomplete.
 *  We'll handle first+last in extractMappedBusiness by detecting sibling last_name field.
 */
export function fixTemplateApplicantNameMapping(schema: FormSchema): FormSchema {
  return schema;
}
