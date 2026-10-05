/**
 * Ensure DATABASE_URL is set for Prisma CLI (generate/migrate).
 * Vercel Prisma integrations often inject prefixed names instead of DATABASE_URL.
 */
import { spawnSync } from "node:child_process";

const candidates = [
  process.env.DATABASE_URL,
  process.env.volumepricingmanagerdb_DATABASE_URL,
  process.env.volumepricingmanagerdb_POSTGRES_URL,
  process.env.volumepricingmanagerdb_PRISMA_DATABASE_URL,
  process.env.POSTGRES_PRISMA_URL,
  process.env.POSTGRES_URL,
  process.env.PRISMA_DATABASE_URL,
];

const databaseUrl = candidates.find((value) => typeof value === "string" && value.length > 0);

if (!databaseUrl) {
  console.error(`
DATABASE_URL is missing at build time.

In Vercel → Project → Settings → Environment Variables:
  1. Add DATABASE_URL (same value as your Prisma Postgres URL)
  2. Enable it for Production (and Preview)
  3. Ensure it is available to Builds

Or rely on one of:
  volumepricingmanagerdb_DATABASE_URL
  volumepricingmanagerdb_POSTGRES_URL
  POSTGRES_URL
`);
  process.exit(1);
}

process.env.DATABASE_URL = databaseUrl;

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scripts/run-with-database-url.mjs <command> [args...]");
  process.exit(1);
}

const [command, ...commandArgs] = args;
const result = spawnSync(command, commandArgs, {
  stdio: "inherit",
  env: process.env,
  shell: true,
});

process.exit(result.status ?? 1);
