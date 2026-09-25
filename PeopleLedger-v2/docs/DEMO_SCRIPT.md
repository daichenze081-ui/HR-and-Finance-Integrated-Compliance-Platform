# Demonstration Script — PeopleLedger v2

Use fictional files from `examples/`. The following is a suggested **10–12 minute working demonstration**, not a claim about the competition's permitted video length. The supplied notice says “duration: 30mins”; confirm whether that is required or a limit before recording the final submission.

## Before recording

- Start the full application with `npm ci` then `npm start` using Node.js 24 or later.
- Start from a clean local database for a predictable demonstration. Preserve an existing workspace before choosing a new `PEOPLELEDGER_DB` path.
- Extract `examples/evidence-examples.zip` so its eight PDFs can be uploaded individually.
- Start Ollama with cloud features disabled and `OLLAMA_GO_TEMPLATE=0`, install `qwen3:4b-instruct`, and complete an Agent rehearsal. See [Getting started](../START_HERE.md). This model completed the source-linked SGD 200.00 anomaly review documented in [Validation evidence](VALIDATION.md).
- Record only an actual completed model run as the AI demonstration. If it fails, show the failure and explain the limit; do not present a rule report as model output.

## 1. Explain the problem and scope — 1 minute

Open **Overview**.

Suggested narration:

> Payroll, finance records, bank payments and supporting documents often sit in separate files. PeopleLedger brings them into one review workspace. We reconcile the records with explicit rules, ask an AI Agent to explain the results using source-linked tools, and keep the final decision with human reviewers. This version uses a local database and file integrations.

Point out that reviewer selection simulates roles. Avoid claiming that users are authenticated or that external business accounts are connected.

## 2. Demonstrate actual file integration — 2 minutes

Open **Data imports**. For each file, show **Preview import** and **Confirm replacement**:

| Role | Dataset | File |
| --- | --- | --- |
| HR specialist | Payroll | `payroll-corrected.csv` or `payroll.xlsx` |
| Finance reviewer | Financial ledger | `ledger-demo.csv` or `ledger.xlsx` |
| Finance reviewer | Bank statement | `bank-with-mismatch.csv` |

Show that the records are persisted and the import history records filename, row count and revision. Explain that these schemas accept user-supplied files in the same format, up to 500 rows and 5 MB. Importing a new file replaces its selected dataset.

## 3. Show evidence linking and a genuine mismatch — 2 minutes

In **Evidence & history**, upload the eight sample PDFs with these exact references:

`PAY-202609-001`, `PAY-202609-002`, `PAY-202609-003`, `PAY-202609-004`, `PAY-202609-005`, `PAY-202609-006`, `INV-001`, `RENT-001`.

You may prepare seven uploads before recording and demonstrate the final one on screen. Show the file download and stored hash. State that the documents are fictional and that a hash does not establish authenticity.

Open **Reconciliation**. With all eight evidence files uploaded, the mismatch scenario should have two blocking findings:

- Ledger row `LED-003` expects `SGD 4,950.00` for `PAY-202609-003`, so it has no exact bank match.
- Bank row `BANK-003` contains `SGD 4,750.00`, so it remains unmatched.

Seven ledger rows match; the mismatch is **SGD 200.00**. The software does not force a match or silently change the payment.

## 4. Run the AI Agent — 2–3 minutes, plus model time

Select **Finance reviewer**, open **AI Agent**, refresh the model connection and choose **Local · qwen3:4b-instruct**.

Use this request:

> Use bank_reconciliation to check LED-003 and BANK-003. In the final answer write the exact citations [ledger:LED-003] and [bank:BANK-003]. State the two recorded amounts, whether they matched, and recommend human review. Limit the answer to three sentences.

Select **Run Agent**. Show the provider/model, actual tool calls and results, then the completed draft. The exact wording and tool sequence will vary. Look for relevant references such as `[ledger:LED-003]` and `[bank:BANK-003]`; compare the draft against the deterministic findings rather than trusting the narrative alone.

Open **Reports & approvals**. Show that the draft cannot proceed to finance review while the mismatch remains. The model explains the records; it cannot approve, edit them, pay money or send a message.

## 5. Correct the source and demonstrate approval — 2 minutes

Open **Data imports** and select **Bank statement** as **Finance reviewer**. Select **Edit** for `BANK-003`, change `amount` from `4750.00` to `4950.00`, and enter a change explanation such as “Correcting the fictional demonstration bank row against the source record.” Select **Save changes**. Alternatively, preview and import the complete corrected source, `bank-demo.csv` or `bank.xlsx`.

Return to **Reconciliation**. Expected clean results:

| Metric | Expected result |
| --- | --- |
| Payroll records | 6 |
| Ledger and bank records | 8 each |
| Matched ledger entries | 8 |
| Open findings | 0 |
| Expected net payroll | SGD 35,100.00 |
| Ledger income | SGD 50,000.00 |
| Ledger expenses | SGD 39,100.00 |
| Net cash movement | SGD 10,900.00 |

Show that the previous report is now historical. Run the Agent again to create a draft from the corrected data, or select **Create rule report** if demonstrating the deterministic approval flow separately. Clearly name which report type is being shown.

In **Reports & approvals**:

1. As **Finance reviewer**, select **Review & submit**. Note: “Reviewed the imported source files, eight matches and supporting evidence. No configured-rule findings remain.”
2. As **Director**, select **Approve**. Note: “Reviewed finance's submission and approved this demonstration report.”
3. Show the two decisions and the source snapshot. Explain that a new source change requires a fresh draft.

## 6. Export and identify the remaining integrations — 1 minute

Select **Print / Save PDF**. In **Evidence & history**, select **Export review JSON** and explain that it contains report/source metadata and traces; file bytes are downloaded separately. Refresh the browser to show persisted records.

Open **Connections** and distinguish the completed work from the next phase:

- Excel/CSV integration and local persistence are implemented.
- The local `qwen3:4b-instruct` anomaly review has a verified completed run. Show the current run and its trace; earlier failed tests remain visible.
- Bedrock has an implemented adapter, but no connected AWS account or live call is claimed.
- Teams scheduling, recruitment, direct accounting-system sync and CPF/tax filing remain unimplemented.

End with the real GitHub repository URL, video link and deployment evidence once they exist. Do not substitute the local browser address for a public deployment.
