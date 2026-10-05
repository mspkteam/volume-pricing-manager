import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "react-router";
import { useCallback, useMemo, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import {
  getForm,
  impactOfDeletingField,
  publishForm,
  saveDraft,
} from "../services/forms/form-service";
import {
  createField,
  listFieldTypes,
  newFieldId,
  type FormFieldBase,
  type FormFieldType,
  type FormSchema,
  type BusinessMappingKey,
} from "../services/forms/field-registry";
import { validateConditionReferences } from "../services/forms/conditions";
import { FlashBanner, PageIntro } from "../components/admin/ui";
import { uploadsConfigured, uploadSetupMessage } from "../services/uploads/storage";
import styles from "../styles/form-builder.module.css";

const MAPPING_KEYS: BusinessMappingKey[] = [
  "applicant_name",
  "applicant_email",
  "applicant_phone",
  "company_name",
  "company_website",
  "company_address",
  "expected_volume",
  "requested_tier",
  "license_document",
  "resale_document",
  "contractor_document",
  "terms_consent",
  "privacy_consent",
];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const form = await getForm(prisma, shop.id, String(params.id));
  if (!form || form.status === "ARCHIVED") {
    throw new Response("Form not found", { status: 404 });
  }

  const tiers = await prisma.pricingTier.findMany({
    where: { shopId: shop.id, isArchived: false, isActive: true },
    orderBy: { minSpendMinor: "asc" },
    select: { id: true, name: true, minSpendMinor: true },
  });

  const draftSchema = form.draftSchema as unknown as FormSchema;
  const uploadOk = uploadsConfigured();

  return {
    form: {
      id: form.id,
      handle: form.handle,
      status: form.status,
      draftVersion: form.draftVersion,
      publishedVersion: form.publishedVersion,
      title: form.title,
    },
    schema: draftSchema,
    tiers: tiers.map((t) => ({
      id: t.id,
      name: t.name,
      minSpendMinor: String(t.minSpendMinor),
    })),
    currencyCode: shop.currencyCode,
    fieldTypes: listFieldTypes().map((d) => ({
      type: d.type,
      label: d.label,
      category: d.category,
    })),
    uploadsConfigured: uploadOk,
    uploadSetupMessage: uploadOk ? null : uploadSetupMessage(),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  let schema: FormSchema | null = null;

  try {
    const rawSchema = String(formData.get("schema") || "");
    schema = JSON.parse(rawSchema) as FormSchema;

    if (intent === "save") {
      const result = await saveDraft(prisma, {
        shopId: shop.id,
        shopDomain: session.shop,
        formId: String(params.id),
        schema,
        title: schema.title,
        description: schema.description,
        requireLogin: schema.requireLogin,
        purpose: schema.purpose,
      });
      return {
        ok: true,
        message: `Draft saved (v${result.form.draftVersion}).`,
        conditionIssues: result.conditionIssues,
      };
    }

    if (intent === "publish") {
      await saveDraft(prisma, {
        shopId: shop.id,
        shopDomain: session.shop,
        formId: String(params.id),
        schema,
        title: schema.title,
        description: schema.description,
        requireLogin: schema.requireLogin,
        purpose: schema.purpose,
      });
      const published = await publishForm(prisma, {
        shopId: shop.id,
        shopDomain: session.shop,
        formId: String(params.id),
      });
      return {
        ok: true,
        message: `Published v${published.form.publishedVersion}.`,
      };
    }
  } catch (err) {
    if (err instanceof Response) throw err;
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Action failed",
      conditionIssues: schema ? validateConditionReferences(schema) : undefined,
    };
  }

  return { ok: false, message: "Unknown action" };
};

type PreviewMode = "builder" | "desktop" | "mobile";

export default function FormBuilderPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const busy = navigation.state !== "idle";

  const [schema, setSchema] = useState<FormSchema>(data.schema);
  const [selectedId, setSelectedId] = useState<string | null>(
    data.schema.fields[0]?.id ?? null,
  );
  const [previewMode, setPreviewMode] = useState<PreviewMode>("builder");
  const [deleteImpact, setDeleteImpact] = useState<string[] | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const selected = useMemo(
    () => schema.fields.find((f) => f.id === selectedId) ?? null,
    [schema.fields, selectedId],
  );

  const fieldTypes = data.fieldTypes;

  const updateSchema = useCallback((updater: (prev: FormSchema) => FormSchema) => {
    setSchema((prev) => updater(prev));
  }, []);

  const addField = useCallback(
    (type: FormFieldType) => {
      const id = newFieldId();
      const field = createField(type, id);
      updateSchema((prev) => ({ ...prev, fields: [...prev.fields, field] }));
      setSelectedId(id);
      setPreviewMode("builder");
    },
    [updateSchema],
  );

  const moveField = useCallback(
    (fieldId: string, delta: number) => {
      updateSchema((prev) => {
        const idx = prev.fields.findIndex((f) => f.id === fieldId);
        if (idx < 0) return prev;
        const next = idx + delta;
        if (next < 0 || next >= prev.fields.length) return prev;
        const fields = [...prev.fields];
        const [item] = fields.splice(idx, 1);
        fields.splice(next, 0, item);
        return { ...prev, fields };
      });
    },
    [updateSchema],
  );

  const removeField = useCallback(
    (fieldId: string, confirmed = false) => {
      const impact = impactOfDeletingField(schema, fieldId);
      if (!confirmed && impact.length) {
        setPendingDeleteId(fieldId);
        setDeleteImpact(impact);
        return;
      }
      updateSchema((prev) => {
        const fields = prev.fields.filter((f) => f.id !== fieldId);
        const businessMappings = { ...prev.businessMappings };
        for (const [key, mappedId] of Object.entries(businessMappings)) {
          if (mappedId === fieldId) {
            delete businessMappings[key as BusinessMappingKey];
          }
        }
        return { ...prev, fields, businessMappings };
      });
      setSelectedId((cur) => (cur === fieldId ? null : cur));
      setPendingDeleteId(null);
      setDeleteImpact(null);
    },
    [schema, updateSchema],
  );

  const patchField = useCallback(
    (fieldId: string, patch: Partial<FormFieldBase>) => {
      updateSchema((prev) => ({
        ...prev,
        fields: prev.fields.map((f) => (f.id === fieldId ? { ...f, ...patch } : f)),
      }));
    },
    [updateSchema],
  );

  const onDropReorder = useCallback(
    (targetId: string) => {
      if (!dragId || dragId === targetId) {
        setDragId(null);
        return;
      }
      updateSchema((prev) => {
        const from = prev.fields.findIndex((f) => f.id === dragId);
        const to = prev.fields.findIndex((f) => f.id === targetId);
        if (from < 0 || to < 0) return prev;
        const fields = [...prev.fields];
        const [item] = fields.splice(from, 1);
        fields.splice(to, 0, item);
        return { ...prev, fields };
      });
      setDragId(null);
    },
    [dragId, updateSchema],
  );

  const persist = useCallback(
    (intent: "save" | "publish") => {
      const fd = new FormData();
      fd.set("intent", intent);
      fd.set("schema", JSON.stringify(schema));
      submit(fd, { method: "post" });
    },
    [schema, submit],
  );

  return (
    <s-page heading={schema.title || "Form builder"}>
      <s-stack slot="primary-action" direction="inline" gap="small">
        <s-button href={`/app/forms/${data.form.id}/embed`} variant="tertiary">
          Embed
        </s-button>
        <s-button href={`/app/forms/${data.form.id}/submissions`} variant="tertiary">
          Submissions
        </s-button>
        <s-button
          variant="secondary"
          disabled={busy}
          onClick={((e: Event) => {
            e.preventDefault();
            persist("save");
          }) as any}
        >
          Save draft
        </s-button>
        <s-button
          disabled={busy}
          onClick={((e: Event) => {
            e.preventDefault();
            persist("publish");
          }) as any}
        >
          Publish
        </s-button>
      </s-stack>

      {actionData?.message ? (
        <FlashBanner message={actionData.message} ok={actionData.ok} />
      ) : null}
      {actionData?.conditionIssues?.length ? (
        <s-banner tone="warning">
          Condition issues:{" "}
          {actionData.conditionIssues.map((i) => i.message).join("; ")}
        </s-banner>
      ) : null}
      {!data.uploadsConfigured ? (
        <s-banner tone="warning">{data.uploadSetupMessage}</s-banner>
      ) : null}

      <PageIntro>
        Handle <code>{data.form.handle}</code> · {data.form.status}
        {data.form.publishedVersion ? ` · published v${data.form.publishedVersion}` : ""} · draft
        v{data.form.draftVersion}
      </PageIntro>

      <div className={styles.toolbar}>
        <label>
          Title
          <input
            type="text"
            value={schema.title}
            onChange={(e) => updateSchema((p) => ({ ...p, title: e.target.value }))}
          />
        </label>
        <label>
          Purpose
          <select
            value={schema.purpose}
            onChange={(e) =>
              updateSchema((p) => ({
                ...p,
                purpose: e.target.value as FormSchema["purpose"],
              }))
            }
          >
            <option value="GENERAL">GENERAL</option>
            <option value="WHOLESALE">WHOLESALE</option>
          </select>
        </label>
        <label>
          <span>
            <input
              type="checkbox"
              checked={schema.requireLogin}
              onChange={(e) =>
                updateSchema((p) => ({ ...p, requireLogin: e.target.checked }))
              }
            />{" "}
            Require login
          </span>
        </label>
        <label>
          Description
          <input
            type="text"
            value={schema.description}
            onChange={(e) =>
              updateSchema((p) => ({ ...p, description: e.target.value }))
            }
          />
        </label>
        <div className={styles.previewToggle}>
          {(["builder", "desktop", "mobile"] as PreviewMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={previewMode === mode ? styles.active : undefined}
              onClick={() => setPreviewMode(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {deleteImpact && pendingDeleteId ? (
        <s-banner tone="warning">
          Deleting this field affects: {deleteImpact.join(", ")}.{" "}
          <s-button
            variant="primary"
            tone="critical"
            onClick={((e: Event) => {
              e.preventDefault();
              removeField(pendingDeleteId, true);
            }) as any}
          >
            Confirm delete
          </s-button>{" "}
          <s-button
            variant="tertiary"
            onClick={((e: Event) => {
              e.preventDefault();
              setDeleteImpact(null);
              setPendingDeleteId(null);
            }) as any}
          >
            Cancel
          </s-button>
        </s-banner>
      ) : null}

      {previewMode === "builder" ? (
        <div className={styles.builder}>
          <aside className={styles.library}>
            <h3>Field library</h3>
            {fieldTypes.map((ft) => (
              <button
                key={ft.type}
                type="button"
                className={styles.libBtn}
                onClick={() => addField(ft.type as FormFieldType)}
              >
                {ft.label}
                <small>{ft.category}</small>
              </button>
            ))}
          </aside>

          <section className={styles.canvas}>
            <h3>Canvas</h3>
            {schema.fields.length === 0 ? (
              <p className={styles.emptyCanvas}>Add fields from the library.</p>
            ) : (
              schema.fields.map((field) => (
                <div
                  key={field.id}
                  className={`${styles.canvasItem}${
                    selectedId === field.id ? ` ${styles.selected}` : ""
                  }`}
                  draggable
                  onDragStart={() => setDragId(field.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDropReorder(field.id)}
                  onClick={() => setSelectedId(field.id)}
                >
                  <div className={styles.canvasItemHead}>
                    <span>
                      <strong>{field.label}</strong>{" "}
                      <small>({field.type})</small>
                    </span>
                    <span className={styles.moveBtns}>
                      <button
                        type="button"
                        title="Move up"
                        onClick={(e) => {
                          e.stopPropagation();
                          moveField(field.id, -1);
                        }}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        title="Move down"
                        onClick={(e) => {
                          e.stopPropagation();
                          moveField(field.id, 1);
                        }}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        title="Remove"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeField(field.id);
                        }}
                      >
                        ×
                      </button>
                    </span>
                  </div>
                </div>
              ))
            )}
          </section>

          <aside className={styles.settings}>
            <h3>Settings</h3>
            {!selected ? (
              <p className={styles.hint}>Select a field to edit.</p>
            ) : (
              <div className={styles.settingsForm}>
                <label>
                  Label
                  <input
                    type="text"
                    value={selected.label}
                    onChange={(e) => patchField(selected.id, { label: e.target.value })}
                  />
                </label>
                <label>
                  Helper text
                  <input
                    type="text"
                    value={selected.helperText || ""}
                    onChange={(e) =>
                      patchField(selected.id, { helperText: e.target.value })
                    }
                  />
                </label>
                <label>
                  Placeholder
                  <input
                    type="text"
                    value={selected.placeholder || ""}
                    onChange={(e) =>
                      patchField(selected.id, { placeholder: e.target.value })
                    }
                  />
                </label>
                <label>
                  Width
                  <select
                    value={selected.width || "full"}
                    onChange={(e) =>
                      patchField(selected.id, {
                        width: e.target.value as FormFieldBase["width"],
                      })
                    }
                  >
                    <option value="full">Full</option>
                    <option value="half">Half</option>
                    <option value="third">Third</option>
                  </select>
                </label>
                {!selected.presentational ? (
                  <label>
                    <span>
                      <input
                        type="checkbox"
                        checked={Boolean(selected.required)}
                        onChange={(e) =>
                          patchField(selected.id, { required: e.target.checked })
                        }
                      />{" "}
                      Required
                    </span>
                  </label>
                ) : null}

                {["dropdown", "multi_select", "radio", "checkbox_group"].includes(
                  selected.type,
                ) ? (
                  <label>
                    Options (value|label per line)
                    <textarea
                      rows={5}
                      value={(selected.options || [])
                        .map((o) => `${o.value}|${o.label}`)
                        .join("\n")}
                      onChange={(e) => {
                        const options = e.target.value
                          .split("\n")
                          .map((line) => line.trim())
                          .filter(Boolean)
                          .map((line) => {
                            const [value, ...rest] = line.split("|");
                            return {
                              value: value.trim(),
                              label: (rest.join("|") || value).trim(),
                            };
                          });
                        patchField(selected.id, { options });
                      }}
                    />
                  </label>
                ) : null}

                {selected.type === "tier_select" ? (
                  <>
                    <label>
                      Display mode
                      <select
                        value={String(selected.settings?.displayMode || "both")}
                        onChange={(e) =>
                          patchField(selected.id, {
                            settings: {
                              ...(selected.settings || {}),
                              displayMode: e.target.value,
                            },
                          })
                        }
                      >
                        <option value="both">Name + range</option>
                        <option value="names">Names only</option>
                        <option value="ranges">Ranges only</option>
                      </select>
                    </label>
                    <label>
                      Available tiers (empty = all)
                      <select
                        multiple
                        value={(selected.settings?.availableTierIds as string[]) || []}
                        onChange={(e) => {
                          const availableTierIds = Array.from(
                            e.target.selectedOptions,
                          ).map((o) => o.value);
                          patchField(selected.id, {
                            settings: {
                              ...(selected.settings || {}),
                              availableTierIds,
                            },
                          });
                        }}
                      >
                        {data.tiers.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className={styles.hint}>
                      Currency: {data.currencyCode}. Expected volume does not auto-grant a
                      discount.
                    </p>
                  </>
                ) : null}

                <label>
                  Visibility JSON
                  <textarea
                    rows={3}
                    value={
                      selected.visibility
                        ? JSON.stringify(selected.visibility, null, 2)
                        : ""
                    }
                    placeholder='{"logic":"AND","clauses":[{"fieldId":"...","operator":"equals","value":"..."}]}'
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      if (!raw) {
                        patchField(selected.id, { visibility: null });
                        return;
                      }
                      try {
                        patchField(selected.id, { visibility: JSON.parse(raw) });
                      } catch {
                        /* ignore while typing */
                      }
                    }}
                  />
                </label>
                <label>
                  Required-when JSON
                  <textarea
                    rows={3}
                    value={
                      selected.requiredWhen
                        ? JSON.stringify(selected.requiredWhen, null, 2)
                        : ""
                    }
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      if (!raw) {
                        patchField(selected.id, { requiredWhen: null });
                        return;
                      }
                      try {
                        patchField(selected.id, { requiredWhen: JSON.parse(raw) });
                      } catch {
                        /* ignore while typing */
                      }
                    }}
                  />
                </label>
              </div>
            )}

            <h3 style={{ marginTop: "1.25rem" }}>Business mappings</h3>
            <p className={styles.hint}>
              Wholesale forms require applicant_email, company_name, and company_address
              before publish.
            </p>
            {MAPPING_KEYS.map((key) => (
              <div key={key} className={styles.mapRow}>
                <label>
                  {key}
                  <select
                    value={schema.businessMappings[key] || ""}
                    onChange={(e) => {
                      const value = e.target.value;
                      updateSchema((prev) => {
                        const businessMappings = { ...prev.businessMappings };
                        if (!value) delete businessMappings[key];
                        else businessMappings[key] = value;
                        return { ...prev, businessMappings };
                      });
                    }}
                  >
                    <option value="">—</option>
                    {schema.fields
                      .filter((f) => !f.presentational)
                      .map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.label} ({f.type})
                        </option>
                      ))}
                  </select>
                </label>
              </div>
            ))}
          </aside>
        </div>
      ) : (
        <div
          className={`${styles.previewFrame}${
            previewMode === "mobile" ? ` ${styles.mobile}` : ""
          }`}
        >
          <h2>{schema.title}</h2>
          {schema.description ? <p>{schema.description}</p> : null}
          {schema.fields.map((field) =>
            field.presentational ? (
              <div key={field.id} className={styles.previewField}>
                {field.type === "heading" || field.type === "section" ? (
                  <h3>{field.label}</h3>
                ) : field.type === "divider" ? (
                  <hr />
                ) : (
                  <p>{field.label}</p>
                )}
              </div>
            ) : (
              <div
                key={field.id}
                className={styles.previewField}
                data-width={field.width || "full"}
              >
                <label>
                  {field.label}
                  {field.required ? " *" : ""}
                  <input
                    type="text"
                    disabled
                    placeholder={field.placeholder || field.type}
                  />
                </label>
                {field.helperText ? (
                  <p className={styles.hint}>{field.helperText}</p>
                ) : null}
              </div>
            ),
          )}
        </div>
      )}

      {/* Hidden Form keeps React Router Form import used for consistency */}
      <Form method="post" style={{ display: "none" }} aria-hidden>
        <input type="hidden" name="intent" value="save" />
      </Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);
