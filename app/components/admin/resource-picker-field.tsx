import { useAppBridge } from "@shopify/app-bridge-react";
import { useState } from "react";

export type PickedResource = { id: string; title: string };

/**
 * Hidden comma-separated GID field + Shopify Admin resource picker UI.
 */
export function ResourcePickerField({
  type,
  name,
  label,
  helpText,
  initialItems,
}: {
  type: "product" | "collection";
  name: string;
  label: string;
  helpText?: string;
  initialItems: PickedResource[];
}) {
  const shopify = useAppBridge();
  const [items, setItems] = useState<PickedResource[]>(initialItems);

  async function openPicker() {
    try {
      const selected = await shopify.resourcePicker({
        type,
        multiple: true,
        selectionIds: items.map((i) => ({ id: i.id })),
        ...(type === "product" ? { filter: { variants: false } } : {}),
      });
      if (!selected) return;
      const next = (Array.isArray(selected) ? selected : [selected]).map((row) => ({
        id: String(row.id),
        title: String((row as { title?: string }).title || row.id),
      }));
      setItems(next);
    } catch {
      // User closed picker or App Bridge unavailable
    }
  }

  function remove(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  return (
    <div className="vpm-picker">
      <div className="vpm-picker-head">
        <span className="vpm-picker-label">{label}</span>
        <button type="button" className="vpm-btn vpm-btn--secondary" onClick={openPicker}>
          {items.length ? `Change ${type}s` : `Select ${type}s`}
        </button>
      </div>
      {helpText ? <p className="vpm-picker-help">{helpText}</p> : null}
      <input type="hidden" name={name} value={items.map((i) => i.id).join(",")} />
      {items.length === 0 ? (
        <p className="vpm-picker-empty">None selected — all {type}s count toward spend.</p>
      ) : (
        <ul className="vpm-picker-list">
          {items.map((item) => (
            <li key={item.id} className="vpm-picker-chip">
              <span title={item.id}>{item.title}</span>
              <button type="button" className="vpm-picker-remove" onClick={() => remove(item.id)} aria-label={`Remove ${item.title}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
