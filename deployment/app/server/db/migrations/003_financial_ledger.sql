ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS source_rows jsonb;
CREATE TABLE IF NOT EXISTS ledger_entries (
 id text PRIMARY KEY, case_id text NOT NULL REFERENCES cases(id),
 batch_id text NOT NULL REFERENCES payment_batches(id), source_id text NOT NULL,
 period text NOT NULL, direction text NOT NULL CHECK(direction IN ('in','out')),
 category text NOT NULL, department text, cost_center text, amount_cents bigint NOT NULL CHECK(amount_cents>0),
 reference text NOT NULL, evidence_ref text, description text, value_date text NOT NULL,
 created_at text NOT NULL, created_by text NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_entries_case_idx ON ledger_entries(case_id,reference);
