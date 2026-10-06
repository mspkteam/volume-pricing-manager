import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { useNavigate } from "react-router";
import {
  pricingCompatibilityLabel,
  pricingStatusLabel,
} from "../../lib/pricing-status";

export function PageIntro({ children }: { children: ReactNode }) {
  return <p className="vpm-page-intro">{children}</p>;
}

export function FlashBanner({
  message,
  ok,
}: {
  message: string;
  ok?: boolean;
}) {
  return <s-banner tone={ok ? "success" : "critical"}>{message}</s-banner>;
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="vpm-stat-grid">{children}</div>;
}

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="vpm-stat-card">
      <span className="vpm-stat-label">{label}</span>
      <span className="vpm-stat-value">{value}</span>
      {hint ? <span className="vpm-stat-hint">{hint}</span> : null}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div className="vpm-panel vpm-panel--subdued">
      <div className="vpm-empty">
        <p className="vpm-empty-title">{title}</p>
        <p className="vpm-empty-body">{body}</p>
        {children ? (
          <div className="vpm-actions" style={{ justifyContent: "center" }}>
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * In-app navigation for the embedded admin.
 * Uses React Router navigate + href so App Bridge and RR stay in sync.
 */
export function AdminLink({
  to,
  children,
  className,
}: {
  to: string;
  children: ReactNode;
  className?: string;
}) {
  const navigate = useNavigate();
  return (
    <a
      href={to}
      className={className || "vpm-link"}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function Field({
  label,
  name,
  type = "text",
  defaultValue,
  required,
  placeholder,
  className,
  ...rest
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string | number | null;
  required?: boolean;
  placeholder?: string;
  className?: string;
} & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "name" | "defaultValue" | "type" | "className"
>) {
  return (
    <label className={`vpm-field${className ? ` ${className}` : ""}`}>
      {label}
      <input
        type={type}
        name={name}
        defaultValue={defaultValue ?? ""}
        required={required}
        placeholder={placeholder}
        {...rest}
      />
    </label>
  );
}

export function TextArea({
  label,
  name,
  defaultValue,
  rows = 3,
}: {
  label: string;
  name: string;
  defaultValue?: string | null;
  rows?: number;
}) {
  return (
    <label className="vpm-field">
      {label}
      <textarea name={name} rows={rows} defaultValue={defaultValue ?? ""} />
    </label>
  );
}

export function Check({
  label,
  name,
  defaultChecked,
}: {
  label: string;
  name: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="vpm-check">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} /> {label}
    </label>
  );
}

export function SelectField({
  label,
  name,
  defaultValue,
  children,
  ...rest
}: {
  label: string;
  name: string;
  defaultValue?: string;
  children: ReactNode;
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, "name" | "defaultValue">) {
  return (
    <label className="vpm-field">
      {label}
      <select name={name} defaultValue={defaultValue} {...rest}>
        {children}
      </select>
    </label>
  );
}

export function SubmitButton({
  children,
  variant,
  name,
  value,
  disabled,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "critical";
  name?: string;
  value?: string;
  disabled?: boolean;
}) {
  const cls =
    variant === "secondary"
      ? "vpm-btn vpm-btn--secondary"
      : variant === "critical"
        ? "vpm-btn vpm-btn--critical"
        : "vpm-btn";
  return (
    <button type="submit" className={cls} name={name} value={value} disabled={disabled}>
      {children}
    </button>
  );
}

export function TierName({
  name,
  badgeColor,
  fallback,
}: {
  name: string;
  badgeColor?: string;
  fallback?: boolean;
}) {
  return (
    <span className="vpm-tier-name">
      {badgeColor ? (
        <span
          className="vpm-tier-dot"
          style={{ backgroundColor: badgeColor }}
          aria-hidden
        />
      ) : null}
      {name}
      {fallback ? <span className="vpm-tag">Fallback</span> : null}
    </span>
  );
}

export function ChecklistPanel({
  items,
}: {
  items: Array<{ id: string; label: string; done: boolean; href?: string }>;
}) {
  const doneCount = items.filter((i) => i.done).length;
  return (
    <div className="vpm-panel">
      <s-paragraph>
        <s-text type="strong">
          {doneCount} of {items.length} complete
        </s-text>
      </s-paragraph>
      <ul className="vpm-checklist">
        {items.map((item) => (
          <li key={item.id} className="vpm-checklist-item">
            <span
              className={
                item.done
                  ? "vpm-checklist-icon vpm-checklist-icon--done"
                  : "vpm-checklist-icon vpm-checklist-icon--pending"
              }
              aria-hidden
            >
              {item.done ? "✓" : ""}
            </span>
            {item.href && !item.done ? (
              <AdminLink to={item.href}>{item.label}</AdminLink>
            ) : (
              <span>{item.label}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PricingStatusBadge({
  status,
  compatibility,
}: {
  status: string;
  compatibility?: string;
}) {
  const label = pricingStatusLabel(status as never);
  const tone =
    status === "SYNCED" || status === "READY"
      ? "success"
      : status === "FAILED" || status === "UNSUPPORTED"
        ? "critical"
        : status === "SYNCING"
          ? "info"
          : "warning";
  return (
    <s-stack direction="inline" gap="small">
      <s-badge tone={tone}>{label}</s-badge>
      {compatibility ? (
        <s-badge>{pricingCompatibilityLabel(compatibility as never)}</s-badge>
      ) : null}
    </s-stack>
  );
}

export function ApplicationStatusBadge({ status }: { status: string }) {
  const tone =
    status === "APPROVED"
      ? "success"
      : status === "REJECTED" || status === "WITHDRAWN"
        ? "critical"
        : status === "NEEDS_INFORMATION"
          ? "warning"
          : status === "PENDING"
            ? "warning"
            : undefined;
  return <s-badge tone={tone}>{status.replace(/_/g, " ")}</s-badge>;
}

export function buildQuery(params: Record<string, string | number | undefined | null>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}
