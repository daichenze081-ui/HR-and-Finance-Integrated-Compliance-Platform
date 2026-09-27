-- PeopleLedger initial schema.
-- Money is stored as BIGINT minor units (SGD cents); no floating-point column
-- may hold an amount. Timestamps are ISO-8601 text so recorded evidence times
-- are byte-stable and independent of server timezone settings.

CREATE TABLE IF NOT EXISTS "users" (
  "id"            text PRIMARY KEY,
  "email"         text NOT NULL UNIQUE,
  "display_name"  text NOT NULL,
  "role"          text NOT NULL CHECK ("role" IN ('hr','finance_preparer','reviewer','management','director','auditor','admin')),
  "password_hash" text NOT NULL,
  "password_salt" text NOT NULL,
  "active"        integer NOT NULL DEFAULT 1,
  "created_at"    text NOT NULL,
  "last_login_at" text
);

CREATE TABLE IF NOT EXISTS "sessions" (
  "id"          text PRIMARY KEY,
  "user_id"     text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash"  text NOT NULL UNIQUE,
  "created_at"  text NOT NULL,
  "expires_at"  text NOT NULL,
  "revoked_at"  text,
  "user_agent"  text
);
CREATE INDEX IF NOT EXISTS "sessions_user_idx" ON "sessions" ("user_id");

CREATE TABLE IF NOT EXISTS "rule_sets" (
  "id"         text PRIMARY KEY,
  "version"    text NOT NULL,
  "label"      text NOT NULL,
  "disclaimer" text NOT NULL,
  "config"     jsonb NOT NULL,
  "created_at" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "cases" (
  "id"            text PRIMARY KEY,
  "title"         text NOT NULL,
  "period"        text NOT NULL CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  "status"        text NOT NULL DEFAULT 'open',
  "data_revision" integer NOT NULL DEFAULT 1 CHECK ("data_revision" >= 1),
  "rule_set_id"   text NOT NULL REFERENCES "rule_sets"("id"),
  "created_at"    text NOT NULL,
  "created_by"    text NOT NULL
);

-- Case-level access control. A row may be time limited, which is how read-only
-- auditor access is granted.
CREATE TABLE IF NOT EXISTS "case_members" (
  "id"         text PRIMARY KEY,
  "case_id"    text NOT NULL REFERENCES "cases"("id") ON DELETE CASCADE,
  "user_id"    text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "case_role"  text NOT NULL,
  "granted_by" text NOT NULL,
  "granted_at" text NOT NULL,
  "expires_at" text,
  "revoked_at" text
);
CREATE INDEX IF NOT EXISTS "case_members_lookup_idx" ON "case_members" ("case_id", "user_id");

CREATE TABLE IF NOT EXISTS "employees" (
  "id"           text PRIMARY KEY,
  "case_id"      text NOT NULL REFERENCES "cases"("id") ON DELETE CASCADE,
  "employee_no"  text NOT NULL,
  "display_name" text NOT NULL,
  "department"   text NOT NULL,
  "cost_center"  text,
  "source"       text NOT NULL,
  "candidate_id" text,
  "start_date"   text,
  "created_at"   text NOT NULL,
  UNIQUE ("case_id", "employee_no")
);

CREATE TABLE IF NOT EXISTS "payroll_records" (
  "id"               text PRIMARY KEY,
  "case_id"          text NOT NULL REFERENCES "cases"("id") ON DELETE CASCADE,
  "employee_no"      text NOT NULL,
  "name"             text NOT NULL,
  "department"       text NOT NULL,
  "cost_center"      text,
  "period"           text NOT NULL CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  "base_pay_cents"   bigint NOT NULL CHECK ("base_pay_cents" >= 0),
  "allowances_cents" bigint NOT NULL CHECK ("allowances_cents" >= 0),
  "deductions_cents" bigint NOT NULL CHECK ("deductions_cents" >= 0),
  "net_paid_cents"   bigint NOT NULL CHECK ("net_paid_cents" >= 0),
  "evidence_ref"     text,
  "revision"         integer NOT NULL DEFAULT 1,
  "created_at"       text NOT NULL,
  "updated_at"       text NOT NULL,
  "updated_by"       text NOT NULL,
  UNIQUE ("case_id", "employee_no", "period")
);
CREATE INDEX IF NOT EXISTS "payroll_case_idx" ON "payroll_records" ("case_id");

CREATE TABLE IF NOT EXISTS "record_changes" (
  "id"        text PRIMARY KEY,
  "case_id"   text NOT NULL REFERENCES "cases"("id") ON DELETE CASCADE,
  "record_id" text NOT NULL,
  "revision"  integer NOT NULL,
  "note"      text NOT NULL,
  "changes"   jsonb NOT NULL,
  "actor_id"  text NOT NULL,
  "at"        text NOT NULL
);
CREATE INDEX IF NOT EXISTS "record_changes_case_idx" ON "record_changes" ("case_id");

CREATE TABLE IF NOT EXISTS "checks" (
  "id"            text PRIMARY KEY,
  "case_id"       text NOT NULL REFERENCES "cases"("id") ON DELETE CASCADE,
  "data_revision" integer NOT NULL,
  "rule_version"  text NOT NULL,
  "rule_set_id"   text NOT NULL,
  "issues"        jsonb NOT NULL,
  "totals"        jsonb NOT NULL,
  "created_at"    text NOT NULL,
  "created_by"    text NOT NULL
);
CREATE INDEX IF NOT EXISTS "checks_case_idx" ON "checks" ("case_id", "created_at");

CREATE TABLE IF NOT EXISTS "payment_batches" (
  "id"          text PRIMARY KEY,
  "case_id"     text NOT NULL REFERENCES "cases"("id") ON DELETE CASCADE,
  "filename"    text NOT NULL,
  "row_count"   integer NOT NULL,
  "total_cents" bigint NOT NULL,
  "status"      text NOT NULL,
  -- Content digest makes a repeated submission of the same file detectable.
  "digest"      text NOT NULL UNIQUE,
  "created_at"  text NOT NULL,
  "created_by"  text NOT NULL
);

CREATE TABLE IF NOT EXISTS "payments" (
  "id"           text PRIMARY KEY,
  "case_id"      text NOT NULL REFERENCES "cases"("id") ON DELETE CASCADE,
  "batch_id"     text NOT NULL REFERENCES "payment_batches"("id") ON DELETE CASCADE,
  "employee_no"  text NOT NULL,
  "period"       text NOT NULL CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  "amount_cents" bigint NOT NULL CHECK ("amount_cents" >= 0),
  "payment_ref"  text NOT NULL,
  "paid_at"      text NOT NULL,
  "created_at"   text NOT NULL,
  "created_by"   text NOT NULL
);
CREATE INDEX IF NOT EXISTS "payments_case_idx" ON "payments" ("case_id", "employee_no", "period");

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

CREATE TABLE IF NOT EXISTS "evidence_files" (
  "id"             text PRIMARY KEY,
  "case_id"        text NOT NULL REFERENCES "cases"("id") ON DELETE CASCADE,
  "subject_type"   text NOT NULL,
  "subject_id"     text NOT NULL,
  "filename"       text NOT NULL,
  "media_type"     text NOT NULL,
  "size_bytes"     bigint NOT NULL CHECK ("size_bytes" >= 0),
  "sha256"         text NOT NULL,
  "version"        integer NOT NULL DEFAULT 1,
  "source"         text NOT NULL,
  "storage_driver" text NOT NULL,
  "storage_key"    text NOT NULL,
  -- 0 means the content could not be read as a supported document. Such evidence
  -- is marked for manual review and never reported as verified.
  "readable"       integer NOT NULL DEFAULT 1,
  "review_reason"  text,
  "uploaded_by"    text NOT NULL,
  "uploaded_at"    text NOT NULL,
  "superseded_by"  text
);
CREATE INDEX IF NOT EXISTS "evidence_subject_idx" ON "evidence_files" ("case_id", "subject_type", "subject_id");
CREATE INDEX IF NOT EXISTS "evidence_sha_idx" ON "evidence_files" ("sha256");

CREATE TABLE IF NOT EXISTS "reports" (
  "id"               text PRIMARY KEY,
  "case_id"          text NOT NULL REFERENCES "cases"("id") ON DELETE CASCADE,
  "version"          integer NOT NULL,
  "amends_report_id" text,
  "data_revision"    integer NOT NULL,
  "rule_version"     text NOT NULL,
  "check_id"         text NOT NULL,
  "status"           text NOT NULL CHECK ("status" IN ('draft','submitted','finance_reviewed','management_confirmed','approved','rejected','sealed')),
  "mode"             text NOT NULL,
  "run_kind"         text NOT NULL,
  "draft_source"     text NOT NULL,
  "agent_run_id"     text,
  "snapshot"         jsonb NOT NULL,
  "draft"            jsonb NOT NULL,
  -- Digest of the exact inputs a decision was taken against.
  "input_digest"     text NOT NULL,
  "created_by"       text NOT NULL,
  "created_at"       text NOT NULL,
  "updated_at"       text NOT NULL,
  "sealed_at"        text,
  "sealed_by"        text,
  "seal_manifest"    jsonb,
  UNIQUE ("case_id", "version")
);
CREATE INDEX IF NOT EXISTS "reports_case_idx" ON "reports" ("case_id", "version");

CREATE TABLE IF NOT EXISTS "approvals" (
  "id"             text PRIMARY KEY,
  "report_id"      text NOT NULL REFERENCES "reports"("id") ON DELETE CASCADE,
  "case_id"        text NOT NULL,
  "report_version" integer NOT NULL,
  "input_digest"   text NOT NULL,
  "stage"          text NOT NULL,
  "decision"       text NOT NULL,
  "actor_id"       text NOT NULL,
  "actor_role"     text NOT NULL,
  "note"           text NOT NULL,
  "at"             text NOT NULL
);
CREATE INDEX IF NOT EXISTS "approvals_report_idx" ON "approvals" ("report_id");

CREATE TABLE IF NOT EXISTS "jobs" (
  "id"               text PRIMARY KEY,
  "case_id"          text REFERENCES "cases"("id") ON DELETE SET NULL,
  "title"            text NOT NULL,
  "department"       text NOT NULL,
  "cost_center"      text,
  "headcount"        integer NOT NULL DEFAULT 1 CHECK ("headcount" >= 1),
  "salary_min_cents" bigint CHECK ("salary_min_cents" >= 0),
  "salary_max_cents" bigint CHECK ("salary_max_cents" >= 0),
  "description"      text,
  "status"           text NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft','open','closed')),
  "created_by"       text NOT NULL,
  "created_at"       text NOT NULL,
  "opened_at"        text,
  "closed_at"        text
);

CREATE TABLE IF NOT EXISTS "advertisements" (
  "id"          text PRIMARY KEY,
  "job_id"      text NOT NULL REFERENCES "jobs"("id") ON DELETE CASCADE,
  "channel"     text NOT NULL,
  "reference"   text NOT NULL,
  "posted_at"   text NOT NULL,
  "evidence_id" text,
  "created_by"  text NOT NULL,
  "created_at"  text NOT NULL
);
CREATE INDEX IF NOT EXISTS "advertisements_job_idx" ON "advertisements" ("job_id");

CREATE TABLE IF NOT EXISTS "candidates" (
  "id"                 text PRIMARY KEY,
  "job_id"             text NOT NULL REFERENCES "jobs"("id") ON DELETE CASCADE,
  "candidate_ref"      text NOT NULL UNIQUE,
  "full_name"          text NOT NULL,
  "contact_email"      text,
  "stage"              text NOT NULL DEFAULT 'applied'
                        CHECK ("stage" IN ('applied','screening','interview','offer','hired','rejected')),
  "expected_start"     text,
  "offer_amount_cents" bigint CHECK ("offer_amount_cents" >= 0),
  "decision_reason"    text,
  "created_by"         text NOT NULL,
  "created_at"         text NOT NULL,
  "updated_at"         text NOT NULL
);
CREATE INDEX IF NOT EXISTS "candidates_job_idx" ON "candidates" ("job_id");

-- Scorecards are append-only: a correction creates a new revision and the
-- superseded revision remains readable.
CREATE TABLE IF NOT EXISTS "scorecards" (
  "id"             text PRIMARY KEY,
  "candidate_id"   text NOT NULL REFERENCES "candidates"("id") ON DELETE CASCADE,
  "revision"       integer NOT NULL,
  "interviewer_id" text NOT NULL,
  "criteria"       jsonb NOT NULL,
  "recommendation" text NOT NULL,
  "note"           text,
  "supersedes"     text,
  "created_at"     text NOT NULL,
  UNIQUE ("candidate_id", "revision")
);

CREATE TABLE IF NOT EXISTS "interviews" (
  "id"              text PRIMARY KEY,
  "candidate_id"    text NOT NULL REFERENCES "candidates"("id") ON DELETE CASCADE,
  -- Idempotency key: a repeated identical request returns the existing meeting.
  "request_key"     text NOT NULL UNIQUE,
  "organizer_id"    text NOT NULL,
  "provider"        text NOT NULL,
  "status"          text NOT NULL CHECK ("status" IN ('scheduled','rescheduled','cancelled','failed')),
  "scheduled_start" text,
  "scheduled_end"   text,
  "previous_start"  text,
  "join_url"        text,
  "attempt"         integer NOT NULL DEFAULT 1,
  "failure_reason"  text,
  "cancel_reason"   text,
  "created_at"      text NOT NULL,
  "updated_at"      text NOT NULL
);
CREATE INDEX IF NOT EXISTS "interviews_candidate_idx" ON "interviews" ("candidate_id");

CREATE TABLE IF NOT EXISTS "agent_runs" (
  "id"             text PRIMARY KEY,
  "case_id"        text NOT NULL REFERENCES "cases"("id") ON DELETE CASCADE,
  "report_id"      text,
  "requested_by"   text NOT NULL,
  "mode"           text NOT NULL,
  "run_kind"       text NOT NULL,
  "tool_execution" text NOT NULL,
  "draft_source"   text,
  "model_id"       text NOT NULL,
  "prompt_version" text NOT NULL,
  "guardrail_id"   text,
  -- References to inputs, never the raw record content.
  "input_refs"     jsonb NOT NULL,
  "steps"          jsonb NOT NULL,
  "status"         text NOT NULL,
  "failure_stage"  text,
  "output_hash"    text,
  "error"          text,
  "tool_calls"     integer NOT NULL DEFAULT 0,
  "started_at"     text NOT NULL,
  "finished_at"    text
);
CREATE INDEX IF NOT EXISTS "agent_runs_case_idx" ON "agent_runs" ("case_id", "started_at");

CREATE TABLE IF NOT EXISTS "audit_log" (
  "id"           text PRIMARY KEY,
  "at"           text NOT NULL,
  "actor_id"     text NOT NULL,
  "actor_role"   text NOT NULL,
  "case_id"      text,
  "action"       text NOT NULL,
  "subject_type" text,
  "subject_id"   text,
  "detail"       jsonb,
  "ip"           text
);
CREATE INDEX IF NOT EXISTS "audit_case_idx" ON "audit_log" ("case_id", "at");
CREATE INDEX IF NOT EXISTS "audit_action_idx" ON "audit_log" ("action");

CREATE TABLE IF NOT EXISTS "counters" (
  "id"    text PRIMARY KEY,
  "value" bigint NOT NULL DEFAULT 0
);
