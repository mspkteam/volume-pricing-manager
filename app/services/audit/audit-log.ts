/**
 * Audit logging with redaction — never log tokens or full PII dumps.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

const SENSITIVE_KEYS = new Set([
  "accessToken",
  "access_token",
  "password",
  "secret",
  "authorization",
  "refreshToken",
  "refresh_token",
  "apiSecret",
  "client_secret",
]);

export function redact(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k) || /token|secret|password|authorization/i.test(k)) {
        out[k] = "[REDACTED]";
      } else if (k === "email" && typeof v === "string") {
        out[k] = redactEmail(v);
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

export function redactEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "[redacted]";
  const safeUser = user.length <= 2 ? "*" : `${user[0]}***${user[user.length - 1]}`;
  return `${safeUser}@${domain}`;
}

export async function writeAuditLog(
  prisma: PrismaClient,
  input: {
    shopId: string;
    actor: string;
    action: string;
    entityType: string;
    entityId?: string | null;
    reason?: string | null;
    summary: string;
    metadata?: Prisma.InputJsonValue;
  },
) {
  return prisma.auditLogs.create({
    data: {
      shopId: input.shopId,
      actor: input.actor,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      reason: input.reason ?? null,
      summary: input.summary,
      metadata: input.metadata ? (redact(input.metadata) as Prisma.InputJsonValue) : undefined,
    },
  });
}
