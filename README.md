# PeopleLedger — integrated local review workspace

This is the maintained people application, using v2 sample data and local SQLite persistence. Authenticated case access, multi-stage approvals, evidence versions and recruitment are retained.

## Start

Requires **Node.js 24+**. SQLite is built into Node; the only npm dependency remains `pg` for optional PostgreSQL support.

```sh
npm ci
npm run seed
npm start
```

Open http://127.0.0.1:4173. Database: `var/peopleledger.sqlite`. Evidence: `var/evidence/`. Seed is repeatable and never replaces an existing case. An older payroll demo remains a separate case. Back up the database and evidence directory together with the server stopped.

Demo password is `SEED_PASSWORD` (default `Demo!Passw0rd`):

| Responsibility | Account |
|---|---|
| HR edits | hr@peopleledger.demo |
| Imports / preparation | preparer@peopleledger.demo |
| Finance review | reviewer@peopleledger.demo |
| Management confirmation | management@peopleledger.demo |
| Approval / sealing | director@peopleledger.demo |
| Administration | admin@peopleledger.demo |

## v2 sample data

The new September 2026 case uses `examples/payroll-corrected.csv`, `ledger-demo.csv`, `bank-demo.csv` and the supporting PDFs. Six salary payments, one sales receipt and one rent payment match eight bank rows. Income: SGD 50,000.00; expenses: SGD 39,100.00; net bank movement: SGD 10,900.00. PDFs are retained as evidence requiring manual content review.

Financial ledger imports accept native payment files or the v2 ledger schema, including sales and rent. Payroll rows must link to exactly one employee by payment reference, so import corrected payroll first. Bank imports accept native and v2 schemas. Both support CSV and XLSX. Only SGD is supported; unsupported currencies are rejected. Formulas and unsupported workbook features are rejected.

`payroll-demo.csv` and `bank-with-mismatch.csv` remain negative examples. Bank imports append rows; use a new case for a mismatch scenario instead of appending a second statement over the seeded one.

## Workflow

Import / edit → checks and bank reconciliation → report draft → submit → finance review → management confirmation → director approval → seal → evidence ZIP.

Approval stages require separate users. Changes invalidate pending checks and reports. Exports use the selected report's frozen payroll, ledger, bank, import metadata, reconciliation and evidence versions. Older reports without financial snapshots say those inputs are unavailable; current data is never substituted.

## Connections

Copy `.env.example` to `.env` only when customizing settings.

- SQLite is the default persistent database. PostgreSQL requires `DB_DRIVER=postgres`, `DATABASE_URL`, then `npm run migrate` and `npm run seed`. Missing PostgreSQL settings fail explicitly. Incremental migrations upgrade old databases without a reset.
- Mock is the labelled default model. For local AI set `MODEL_DRIVER=ollama`, `OLLAMA_MODEL` to an installed tool-capable model and `OLLAMA_URL=http://127.0.0.1:11434`. Configuration alone does not establish that a real model works. Bedrock remains optional.
- Recruitment remains available; Teams scheduling is simulated. The rules are demonstration bookkeeping checks, not statutory compliance calculations.

## Checks and source packaging

```sh
npm run check
npm test
```

Most regression tests use isolated memory stores and mock models. SQLite tests additionally cover v2 matching, the approval chain, sessions after reopening, rollback, concurrent access and historical exports. Real PostgreSQL, a real model and browser interaction require their own integration checks.

Do not remove individual files from `node_modules`. Exclude the whole generated directory, `.env`, runtime `var/` and old review copies when sharing source. Keep `package.json` and `package-lock.json`; restore dependencies using `npm ci`.

The default homepage is the server workspace. The archived offline demo remains at `/demo/`.
