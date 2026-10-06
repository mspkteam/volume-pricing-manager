/**
 * Private upload storage. Prefer Vercel Blob on Vercel; S3/R2 via signed gateway; memory/dev for local.
 */

import { get as blobGet, put as blobPut } from "@vercel/blob";

export type StoredUpload = {
  storageProvider: string;
  storageKey: string;
  contentType: string;
  byteSize: number;
  checksumSha256?: string;
};

function resolvedProvider(): string {
  const explicit = (process.env.UPLOAD_STORAGE_PROVIDER || "").toLowerCase().trim();
  if (explicit) {
    if (explicit === "vercel" || explicit === "vercel-blob") return "blob";
    return explicit;
  }
  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID) return "blob";
  return "";
}

export function uploadsConfigured(): boolean {
  const provider = resolvedProvider();
  if (provider === "blob") {
    return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
  }
  if (provider === "s3" || provider === "r2") {
    return Boolean(
      process.env.UPLOAD_BUCKET &&
        process.env.UPLOAD_ACCESS_KEY_ID &&
        process.env.UPLOAD_SECRET_ACCESS_KEY,
    );
  }
  if (provider === "memory" || provider === "dev") {
    return process.env.NODE_ENV !== "production" || process.env.ALLOW_DEV_UPLOADS === "true";
  }
  return false;
}

export function uploadSetupMessage(): string {
  return (
    "File uploads require private object storage. On Vercel, create a private Blob store " +
    "(adds BLOB_READ_WRITE_TOKEN). Or set UPLOAD_STORAGE_PROVIDER=s3|r2 with bucket credentials. " +
    "Until configured, forms with file fields cannot accept documents."
  );
}

/** Dev/memory store — not for production multi-instance. */
const memoryBlobs = new Map<string, Buffer>();

function allowedMime(contentType: string, accept: string[]): boolean {
  if (!accept.length) return true;
  return accept.some((a) => {
    if (a.endsWith("/*")) return contentType.startsWith(a.slice(0, -1));
    return contentType === a;
  });
}

/** Lightweight magic-byte checks (not a substitute for malware scanning). */
function sniffOk(buf: Buffer, contentType: string): boolean {
  if (contentType === "application/pdf") return buf.slice(0, 4).toString() === "%PDF";
  if (contentType === "image/jpeg") return buf[0] === 0xff && buf[1] === 0xd8;
  if (contentType === "image/png") {
    return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  }
  return true;
}

export async function storeUpload(args: {
  shopId: string;
  fieldId: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
  accept?: string[];
  maxBytes?: number;
}): Promise<StoredUpload> {
  if (!uploadsConfigured()) {
    throw new Error(uploadSetupMessage());
  }
  const max = args.maxBytes ?? 10 * 1024 * 1024;
  if (args.bytes.byteLength > max) {
    throw new Error(`File exceeds ${max} byte limit`);
  }
  const accept = args.accept ?? ["application/pdf", "image/jpeg", "image/png"];
  if (!allowedMime(args.contentType, accept)) {
    throw new Error("File type not allowed");
  }
  if (!sniffOk(args.bytes, args.contentType)) {
    throw new Error("File content does not match declared type");
  }

  const provider = resolvedProvider() || "memory";
  const key = `${args.shopId}/${args.fieldId}/${crypto.randomUUID()}-${sanitizeName(args.filename)}`;

  if (provider === "blob") {
    const blob = await blobPut(key, args.bytes, {
      access: "private",
      contentType: args.contentType,
      addRandomSuffix: false,
      ...(process.env.BLOB_READ_WRITE_TOKEN
        ? { token: process.env.BLOB_READ_WRITE_TOKEN }
        : {}),
    });
    return {
      storageProvider: "blob",
      storageKey: blob.url,
      contentType: args.contentType,
      byteSize: args.bytes.byteLength,
      checksumSha256: await sha256(args.bytes),
    };
  }

  if (provider === "memory" || provider === "dev") {
    memoryBlobs.set(key, args.bytes);
    return {
      storageProvider: provider,
      storageKey: key,
      contentType: args.contentType,
      byteSize: args.bytes.byteLength,
      checksumSha256: await sha256(args.bytes),
    };
  }

  // S3/R2 via fetch PutObject-compatible endpoint (AWS SigV4 would be ideal;
  // for production configure a signed-URL worker. Here we use a simple PUT if
  // UPLOAD_PUT_BASE_URL is provided for pre-signed style gateways.)
  const putBase = process.env.UPLOAD_PUT_BASE_URL;
  if (!putBase) {
    throw new Error(
      "S3/R2 configured but UPLOAD_PUT_BASE_URL is missing. Use Vercel Blob (BLOB_READ_WRITE_TOKEN) or set a signed-upload gateway.",
    );
  }
  const res = await fetch(`${putBase.replace(/\/$/, "")}/${key}`, {
    method: "PUT",
    headers: {
      "Content-Type": args.contentType,
      Authorization: `Bearer ${process.env.UPLOAD_PUT_TOKEN || ""}`,
    },
    body: new Uint8Array(args.bytes),
  });
  if (!res.ok) throw new Error(`Upload storage failed (${res.status})`);

  return {
    storageProvider: provider,
    storageKey: key,
    contentType: args.contentType,
    byteSize: args.bytes.byteLength,
    checksumSha256: await sha256(args.bytes),
  };
}

export async function readUpload(storageProvider: string, storageKey: string): Promise<Buffer | null> {
  if (storageProvider === "blob") {
    try {
      const result = await blobGet(storageKey, {
        access: "private",
        ...(process.env.BLOB_READ_WRITE_TOKEN
          ? { token: process.env.BLOB_READ_WRITE_TOKEN }
          : {}),
      });
      if (!result?.stream) return null;
      const chunks: Buffer[] = [];
      const reader = result.stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } catch {
      return null;
    }
  }
  if (storageProvider === "memory" || storageProvider === "dev") {
    return memoryBlobs.get(storageKey) ?? null;
  }
  const getBase = process.env.UPLOAD_GET_BASE_URL;
  if (!getBase) return null;
  const res = await fetch(`${getBase.replace(/\/$/, "")}/${storageKey}`, {
    headers: { Authorization: `Bearer ${process.env.UPLOAD_PUT_TOKEN || ""}` },
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

async function sha256(buf: Buffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(buf));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
