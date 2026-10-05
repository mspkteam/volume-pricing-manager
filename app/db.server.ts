import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

/**
 * Vercel Prisma integrations often inject prefixed env names.
 * Normalize to DATABASE_URL before constructing the client.
 */
function ensureDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return;
  const fallback =
    process.env.volumepricingmanagerdb_DATABASE_URL ||
    process.env.volumepricingmanagerdb_POSTGRES_URL ||
    process.env.volumepricingmanagerdb_PRISMA_DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL ||
    process.env.PRISMA_DATABASE_URL;
  if (fallback) {
    process.env.DATABASE_URL = fallback;
  }
}

ensureDatabaseUrl();

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

export default prisma;
