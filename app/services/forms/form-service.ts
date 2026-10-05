import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  emptyFormSchema,
  FORM_TECHNICAL_LIMITS,
  type FormSchema,
} from "./field-registry";
import { validateConditionReferences, findFieldsReferencing } from "./conditions";
import { wholesalePublishRequirements } from "./validate-submission";
import { contractorWholesaleTemplate } from "./templates/contractor-wholesale";
import { writeAuditLog } from "../audit/audit-log";

function parseSchema(raw: unknown): FormSchema {
  const s = raw as FormSchema;
  if (!s || s.version !== 1 || !Array.isArray(s.fields)) {
    throw new Error("Invalid form schema");
  }
  if (s.fields.length > FORM_TECHNICAL_LIMITS.maxFieldsPerForm) {
    throw new Error(`Forms support at most ${FORM_TECHNICAL_LIMITS.maxFieldsPerForm} fields`);
  }
  return s;
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "form"
  );
}

async function uniqueHandle(prisma: PrismaClient, shopId: string, base: string): Promise<string> {
  let handle = slugify(base);
  let i = 0;
  while (true) {
    const candidate = i === 0 ? handle : `${handle}-${i}`;
    const exists = await prisma.applicationForms.findFirst({
      where: { shopId, handle: candidate },
      select: { id: true },
    });
    if (!exists) return candidate;
    i += 1;
  }
}

export async function listForms(prisma: PrismaClient, shopId: string) {
  return prisma.applicationForms.findMany({
    where: { shopId, status: { not: "ARCHIVED" } },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { submissions: true } } },
  });
}

export async function createForm(
  prisma: PrismaClient,
  args: {
    shopId: string;
    shopDomain: string;
    title: string;
    fromTemplate?: "blank" | "contractor_wholesale";
  },
) {
  const schema =
    args.fromTemplate === "contractor_wholesale"
      ? contractorWholesaleTemplate()
      : emptyFormSchema({ title: args.title || "Untitled form" });
  if (args.title) schema.title = args.title;

  const handle = await uniqueHandle(prisma, args.shopId, schema.title);
  const form = await prisma.applicationForms.create({
    data: {
      shopId: args.shopId,
      handle,
      title: schema.title,
      description: schema.description,
      purpose: schema.purpose,
      requireLogin: schema.requireLogin,
      draftSchema: schema as object,
      status: "DRAFT",
    },
  });
  await writeAuditLog(prisma, {
    shopId: args.shopId,
    actor: args.shopDomain,
    action: "form.created",
    entityType: "ApplicationForm",
    entityId: form.id,
    summary: `Created form ${form.title}`,
  });
  return form;
}

export async function getForm(prisma: PrismaClient, shopId: string, formId: string) {
  return prisma.applicationForms.findFirst({ where: { id: formId, shopId } });
}

export async function saveDraft(
  prisma: PrismaClient,
  args: {
    shopId: string;
    shopDomain: string;
    formId: string;
    schema: FormSchema;
    title?: string;
    description?: string;
    requireLogin?: boolean;
    purpose?: "GENERAL" | "WHOLESALE";
  },
) {
  const form = await getForm(prisma, args.shopId, args.formId);
  if (!form || form.status === "ARCHIVED") throw new Error("Form not found");
  const schema = parseSchema(args.schema);
  schema.title = args.title ?? schema.title;
  schema.description = args.description ?? schema.description;
  schema.requireLogin = args.requireLogin ?? schema.requireLogin;
  schema.purpose = args.purpose ?? schema.purpose;

  const conditionIssues = validateConditionReferences(schema);
  if (conditionIssues.length) {
    // Allow saving drafts with issues, but surface them
  }

  const updated = await prisma.applicationForms.update({
    where: { id: form.id },
    data: {
      title: schema.title,
      description: schema.description,
      requireLogin: schema.requireLogin,
      purpose: schema.purpose,
      draftSchema: schema as object,
      draftVersion: { increment: 1 },
    },
  });
  await writeAuditLog(prisma, {
    shopId: args.shopId,
    actor: args.shopDomain,
    action: "form.draft_saved",
    entityType: "ApplicationForm",
    entityId: form.id,
    summary: `Saved draft v${updated.draftVersion}`,
    metadata: { conditionIssues },
  });
  return { form: updated, conditionIssues };
}

export async function duplicateForm(
  prisma: PrismaClient,
  shopId: string,
  shopDomain: string,
  formId: string,
) {
  const form = await getForm(prisma, shopId, formId);
  if (!form) throw new Error("Form not found");
  // Deep-clone so we never mutate the source form's JSON in memory
  const schema = parseSchema(JSON.parse(JSON.stringify(form.draftSchema)));
  schema.title = `${schema.title} (copy)`;
  // createForm starts blank (unique handle), then we overwrite with the copied schema
  const created = await createForm(prisma, {
    shopId,
    shopDomain,
    title: schema.title,
    fromTemplate: "blank",
  });
  return prisma.applicationForms.update({
    where: { id: created.id },
    data: {
      draftSchema: schema as object,
      purpose: schema.purpose,
      requireLogin: schema.requireLogin,
      description: schema.description,
      title: schema.title,
    },
  });
}

export async function archiveForm(
  prisma: PrismaClient,
  shopId: string,
  shopDomain: string,
  formId: string,
) {
  const form = await getForm(prisma, shopId, formId);
  if (!form) throw new Error("Form not found");
  const updated = await prisma.applicationForms.update({
    where: { id: form.id },
    data: { status: "ARCHIVED", archivedAt: new Date(), publishedSchema: Prisma.DbNull },
  });
  await writeAuditLog(prisma, {
    shopId,
    actor: shopDomain,
    action: "form.archived",
    entityType: "ApplicationForm",
    entityId: form.id,
    summary: `Archived form ${form.title}`,
  });
  return updated;
}

export async function publishForm(
  prisma: PrismaClient,
  args: { shopId: string; shopDomain: string; formId: string; note?: string },
) {
  const form = await getForm(prisma, args.shopId, args.formId);
  if (!form || form.status === "ARCHIVED") throw new Error("Form not found");
  const schema = parseSchema(form.draftSchema);

  const conditionIssues = validateConditionReferences(schema);
  if (conditionIssues.length) {
    throw new Error(
      `Cannot publish: fix condition issues — ${conditionIssues.map((i) => i.message).join("; ")}`,
    );
  }
  const missingMaps = wholesalePublishRequirements(schema);
  if (missingMaps.length) {
    throw new Error(
      `Wholesale forms require business mappings before publish: ${missingMaps.join(", ")}`,
    );
  }

  const nextVersion = (form.publishedVersion ?? 0) + 1;
  const cacheKey = `v${nextVersion}_${crypto.randomUUID().slice(0, 8)}`;

  const version = await prisma.formVersions.create({
    data: {
      formId: form.id,
      version: nextVersion,
      schema: schema as object,
      cacheKey,
      publishedBy: args.shopDomain,
      note: args.note,
    },
  });

  const updated = await prisma.applicationForms.update({
    where: { id: form.id },
    data: {
      status: "PUBLISHED",
      publishedVersion: nextVersion,
      publishedCacheKey: cacheKey,
      publishedAt: new Date(),
      publishedSchema: schema as object,
      title: schema.title,
      description: schema.description,
      requireLogin: schema.requireLogin,
      purpose: schema.purpose,
    },
  });

  await writeAuditLog(prisma, {
    shopId: args.shopId,
    actor: args.shopDomain,
    action: "form.published",
    entityType: "ApplicationForm",
    entityId: form.id,
    summary: `Published ${form.title} v${nextVersion}`,
    metadata: { cacheKey, versionId: version.id },
  });

  return { form: updated, version };
}

export function impactOfDeletingField(schema: FormSchema, fieldId: string) {
  return findFieldsReferencing(schema, fieldId);
}

export async function getPublishedByHandle(
  prisma: PrismaClient,
  shopId: string,
  handle: string,
) {
  return prisma.applicationForms.findFirst({
    where: { shopId, handle, status: "PUBLISHED" },
  });
}
