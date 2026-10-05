import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import { rateLimit } from "../services/forms/rate-limit";
import {
  storeUpload,
  uploadsConfigured,
  uploadSetupMessage,
} from "../services/uploads/storage";
import { getPublishedByHandle } from "../services/forms/form-service";
import type { FormSchema } from "../services/forms/field-registry";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);
  return Response.json({ error: "Method not allowed" }, { status: 405 });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session?.shop) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  if (!uploadsConfigured()) {
    return Response.json({ error: uploadSetupMessage() }, { status: 503 });
  }

  const shop = await ensureShop(prisma, session.shop);
  const handle = String(params.handle || "");
  const url = new URL(request.url);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rl = rateLimit(`upload:${shop.id}:${ip}`, 30, 60_000);
  if (!rl.ok) {
    return Response.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const form = await getPublishedByHandle(prisma, shop.id, handle);
  if (!form) {
    return Response.json({ error: "Form not found" }, { status: 404 });
  }

  const schema = form.publishedSchema as unknown as FormSchema;
  const loggedInCustomerId = url.searchParams.get("logged_in_customer_id");

  let multipart: FormData;
  try {
    multipart = await request.formData();
  } catch {
    return Response.json({ error: "Expected multipart form data" }, { status: 400 });
  }

  const fieldId = String(multipart.get("fieldId") || "");
  const file = multipart.get("file");
  if (!fieldId || !(file instanceof File)) {
    return Response.json({ error: "fieldId and file required" }, { status: 400 });
  }

  const field = schema.fields.find((f) => f.id === fieldId && f.type === "file_upload");
  if (!field) {
    return Response.json({ error: "Invalid upload field" }, { status: 400 });
  }

  const accept = (field.settings?.accept as string[] | undefined) || [
    "application/pdf",
    "image/jpeg",
    "image/png",
  ];
  const maxBytes = Number(field.settings?.maxBytes ?? 10 * 1024 * 1024);
  const bytes = Buffer.from(await file.arrayBuffer());

  try {
    const stored = await storeUpload({
      shopId: shop.id,
      fieldId,
      filename: file.name || "upload",
      contentType: file.type || "application/octet-stream",
      bytes,
      accept,
      maxBytes,
    });

    const row = await prisma.formUploads.create({
      data: {
        shopId: shop.id,
        fieldId,
        originalFilename: file.name || "upload",
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        storageProvider: stored.storageProvider,
        storageKey: stored.storageKey,
        checksumSha256: stored.checksumSha256,
        uploadedByCustomerId: loggedInCustomerId || null,
      },
    });

    return Response.json(
      {
        uploadId: row.id,
        fieldId,
        contentType: row.contentType,
        byteSize: row.byteSize,
        originalFilename: row.originalFilename,
      },
      { status: 201 },
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Upload failed" },
      { status: 400 },
    );
  }
};
