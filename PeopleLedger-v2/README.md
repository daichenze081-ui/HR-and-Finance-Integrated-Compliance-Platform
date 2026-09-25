# PeopleLedger

**Integrated HR and Finance Review Workspace — English MVP, version 2**

PeopleLedger connects payroll, a financial ledger, bank statement rows and supporting files in a local database. Deterministic checks reconcile the records; a tool-calling AI Agent can inspect a pinned data snapshot and prepare a source-linked draft for finance review and director approval.

This version has a real Node.js backend and SQLite persistence. A fresh database starts with an empty workspace. The `examples/` folder contains fictional data for a repeatable demonstration.

## Run the application

Requires **Node.js 24 or later**. In the extracted project folder:

```sh
npm ci
npm start
```

Open `http://127.0.0.1:4173` and leave the server running. The first installation downloads the locked dependencies. File imports, reconciliation, evidence upload and rule reports work without an AI account.

For the practical walkthrough, see [Getting started](START_HERE.md). For local AI setup and recording steps, see the [Demo script](docs/DEMO_SCRIPT.md).

**The full backend must run.** Opening `dist/index.html` directly or uploading only `dist/` to static hosting does not run this version.

## Implemented scope

| Area | What works |
| --- | --- |
| Business-file integration | Excel `.xlsx` and UTF-8 CSV import for payroll, ledger and bank rows; preview, validation and dataset replacement |
| Data persistence | SQLite stores imported records, history, uploaded evidence, Agent runs and report snapshots across browser and server restarts |
| Reconciliation | Integer-cent payroll checks; exact reference, amount, currency and direction matching between ledger and bank; ambiguous matches remain unresolved |
| Cross-dataset checks | Each employee payment links uniquely to a payroll expense; supporting evidence references must identify uploaded files |
| Evidence | Upload and download PDF, PNG and JPEG files with SHA-256 hashes; reference-based links to payroll and ledger rows |
| AI Agent | Six read-only tools, bounded model/tool loop, source-ID validation, saved traces and draft reports; Ollama and Amazon Bedrock adapters |
| Human workflow | Finance review before director approval or return; required notes; old data snapshots cannot receive new decisions |
| Output | Payroll CSV; review JSON containing records, metadata, reports and tool traces; individual evidence downloads; report print / Save PDF |
| Interface | Seven English views: Overview, Data imports, Reconciliation, AI Agent, Reports & approvals, Evidence & history, Connections |

A live local Agent run was verified on **25 September 2026** with **`qwen3:4b-instruct`**. It called `bank_reconciliation` and `read_source`, correctly identified ledger SGD 4,950.00 versus bank SGD 4,750.00, stated the SGD 200.00 difference, cited both source records and saved a draft. The latest completed automated suite had **35 passing tests**. See [Validation evidence](docs/VALIDATION.md) for the run ID, timestamps and limits of these checks.

A model name in the selector means it is available; **completed** activity with actual tool results and a saved draft verifies a run. Failed runs remain visible and do not produce a simulated AI answer.

## Import rules

- Import **1–500 data rows**, up to **5 MB** per CSV/XLSX file. Use the exact headers in the examples; column order may vary.
- Import one payroll month at a time. IDs must be unique within each dataset. Payroll import/edit uses the **HR specialist** role; ledger and bank use **Finance reviewer**.
- Import replaces only the selected dataset. It retains report snapshots and import history, and creates a new workspace revision. Preview expires after 15 minutes or becomes stale after another data change.
- Ledger and bank rows support **SGD** only. Amounts are positive; `type` or `direction` determines inflow/outflow. Dates use `YYYY-MM-DD`.
- Use `.xlsx`, not `.xls` or `.xlsm`. Convert formulas and errors to plain values, and store IDs/references as text to preserve leading zeros. Select the worksheet when a workbook has multiple populated sheets.

The clean example set has six employees, eight ledger entries and eight bank transactions. Expected net payroll is **SGD 35,100.00**; ledger income is **SGD 50,000.00**, expenses **SGD 39,100.00**, and net cash movement **SGD 10,900.00**. These are imported cash movements, not a full accrual profit and loss statement.

## Current boundaries

- Reviewer selection is a **workflow simulation, not authentication**. The server validates the selected role and transitions, but no signed-in user identity exists. This is a single-user, loopback-only workspace.
- AI drafts require human review. Source-ID validation checks whether cited rows exist; it does not prove that every generated statement is accurate. The Agent has no write, payment, approval, messaging or browsing tool.
- Evidence hashes support comparison of file bytes; they do not establish authenticity. The Agent sees evidence metadata, not PDF/image contents. There is no OCR or document extraction.
- The financial ledger is a simple income/expense dataset, not a complete double-entry accounting system. CPF, tax, statutory filings, automated bank feeds and payment execution are not implemented.
- Microsoft Teams scheduling, recruitment/MyCareersFuture, and direct Xero, QuickBooks or ERP synchronization are not implemented. File import is the current integration path.
- Amazon Bedrock has a server adapter but no connected account or verified live call. No AWS deployment, public deployment URL or GitHub repository URL has been created.

## Data and configuration

The default database is `data/peopleledger.sqlite`. `.env` can override `PEOPLELEDGER_DB`, `PORT`, `OLLAMA_URL`, or the optional AWS settings shown in `.env.example`. The database directory and environment files are excluded from Git.

Browser refresh retains data because the backend owns the workspace. The earlier browser-local prototype's data is not migrated automatically. For a clean demonstration, stop the server and use a new database path; preserve the existing database first. To back up all records **and file bytes**, stop the application and copy its `data/` directory. The JSON export includes evidence metadata, not the uploaded file bytes.

## Source and verification

```text
dist/                  English UI and shared payroll validation
server/http.cjs        Loopback HTTP API and file routes
server/imports.cjs     CSV/XLSX validation and normalization
server/xlsx-worker.cjs Bounded Excel parsing worker
server/business.cjs    Reconciliation, integrated rules and Agent tools
server/store.cjs       SQLite persistence, snapshots and workflow decisions
server/agent.cjs       Ollama / Bedrock tool-calling loop
scripts/serve.cjs      Application entry point
examples/              Fictional CSVs, workbooks and supporting PDFs
tests/                 Core and backend integration tests
docs/                  Architecture, demonstration, validation and AWS next steps
```

Run `npm test` and `npm run check` to reproduce the code checks. The last completed suite passed all 35 tests. Automated checks exercise import validation, reconciliation, evidence persistence, revision handling, approvals and Agent-loop behavior with controlled adapters. They do not replace a live model run, account access test or deployment test.

## Submission

Upload the project source to a repository in your own GitHub account. Include the lockfile, server code, tests and examples; exclude `node_modules/`, `.env`, local databases and model files. Add your actual team code, project name, demo video link and deployment evidence. A source ZIP is not a GitHub repository URL, and a localhost address is not a shareable deployment URL.

See [AWS next steps](docs/AWS_NEXT_STEPS.md) before describing any AWS capability as deployed. No license has been selected; the team should choose its distribution terms before public publication.

Known model limitation: a broader review produced incorrect counts and document claims despite valid source IDs. Review all narrative against deterministic results; see [validation evidence](docs/VALIDATION.md). The default request uses a focused ledger/bank pair check.
