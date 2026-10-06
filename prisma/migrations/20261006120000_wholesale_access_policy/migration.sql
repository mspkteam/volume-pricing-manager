-- Clay-like wholesale access / lock policy on Shop
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "wholesaleAccessPolicy" JSONB NOT NULL DEFAULT '{}';
