-- Upgrade existing installations; keep 001 unchanged for compatibility.
-- Third-party bank statement imports. Kept separate from "payments" because a
-- bank statement is external evidence, not the organisation's own ledger entry.
CREATE TABLE IF NOT EXISTS "bank_batches" (
  "id"            text PRIMARY KEY,
  "case_id"       text NOT NULL REFERENCES "cases"("id") ON DELETE CASCADE,
  "filename"      text NOT NULL,
  "source_format" text NOT NULL CHECK ("source_format" IN ('csv','xlsx')),
  "worksheet"     text,
  "row_count"     integer NOT NULL,
  "in_cents"      bigint NOT NULL DEFAULT 0,
  "out_cents"     bigint NOT NULL DEFAULT 0,
  "status"        text NOT NULL,
  -- Content digest makes a repeated submission of the same file detectable.
  "digest"        text NOT NULL UNIQUE,
  "created_at"    text NOT NULL,
  "created_by"    text NOT NULL
);

CREATE TABLE IF NOT EXISTS "bank_transactions" (
  "id"           text PRIMARY KEY,
  "case_id"      text NOT NULL REFERENCES "cases"("id") ON DELETE CASCADE,
  "batch_id"     text NOT NULL REFERENCES "bank_batches"("id") ON DELETE CASCADE,
  "txn_ref"      text NOT NULL,
  "value_date"   text NOT NULL,
  "direction"    text NOT NULL CHECK ("direction" IN ('in','out')),
  "amount_cents" bigint NOT NULL CHECK ("amount_cents" > 0),
  "counterparty" text,
  "description"  text,
  "created_at"   text NOT NULL,
  "created_by"   text NOT NULL
);
CREATE INDEX IF NOT EXISTS "bank_txn_case_idx" ON "bank_transactions" ("case_id", "txn_ref", "direction");

-- Stamped with the data revision and rule version it was produced from, so a
-- later change to either makes the stored result visibly stale.
CREATE TABLE IF NOT EXISTS "reconciliations" (
  "id"              text PRIMARY KEY,
  "case_id"         text NOT NULL REFERENCES "cases"("id") ON DELETE CASCADE,
  "data_revision"   integer NOT NULL,
  "rule_version"    text NOT NULL,
  "matched_count"   integer NOT NULL DEFAULT 0,
  "unmatched_count" integer NOT NULL DEFAULT 0,
  "ambiguous_count" integer NOT NULL DEFAULT 0,
  "result"          jsonb NOT NULL,
  "created_at"      text NOT NULL,
  "created_by"      text NOT NULL
);
CREATE INDEX IF NOT EXISTS "reconciliations_case_idx" ON "reconciliations" ("case_id", "created_at");

