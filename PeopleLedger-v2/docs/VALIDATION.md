# Validation Evidence — PeopleLedger v2

This record separates automated tests, a real local-model run and the capabilities still unverified. Validation used fictional example records on 25 September 2026. No AWS account, external business-system account or public deployment was involved.

## Real local AI anomaly review

| Field | Recorded value |
| --- | --- |
| Run ID | `874168f5-dc25-47f7-8305-c3d19b86ad97` |
| Provider / model | Local Ollama / `qwen3:4b-instruct` |
| Runtime | Ollama 0.34.4; local GGUF Q4_K_M model |
| Started | 25 September 2026, 12:46:52 UTC |
| Completed | 25 September 2026, 12:47:13 UTC |
| Elapsed time | Approximately 21 seconds for this run; not a performance guarantee |
| Data snapshot | Workspace revision 13 |
| Result | `completed`; AI draft saved in Reports & approvals |
| Tools used | `bank_reconciliation`; `read_source` with `sourceId: ledger:LED-003` |

The pinned snapshot contained ledger row `LED-003` at **SGD 4,950.00** and bank row `BANK-003` at **SGD 4,750.00**, both referencing `PAY-202609-003`. The deterministic reconciliation left both rows unresolved.

The model received actual tool results, identified the **SGD 200.00** difference, cited `[ledger:LED-003]` and `[bank:BANK-003]`, and recommended a human check. Its draft was accepted only after the Agent validated the presence of tool activity and valid source IDs. This was a real local inference result, not a canned response or a mocked model adapter.

The source row was then edited through the English UI: `BANK-003` changed to `4950.00`, moving the workspace to **revision 14**. Reconciliation showed **eight matches and zero findings**. The revision-13 AI draft retained the earlier mismatch snapshot and became historical; it cannot receive a new approval against the changed data. These revision numbers identify this test workspace and are not required values for a fresh installation.

Earlier runs with the original thinking model included failures and remain in the local activity history. Their presence is not presented as successful inference. The supported setup now downloads `qwen3:4b-instruct` directly and uses the native chat-template path; no custom compatibility alias is needed.

## Observed limits in a broader request

A broader review at revision 14 (run `02ecdf05-b7a1-4fee-b26a-edf04fd6378f`, 12:54:10–12:55:09 UTC) called five real tools and completed after one model revision to add omitted citations. However, its prose incorrectly described eight payroll entries rather than six, confused payroll expense with total ledger expense, and claimed a supporting invoice was absent although its file metadata existed. That draft is retained for transparency and must not be approved as accurate.

This demonstrates a material limit: successful tool use and valid record IDs do not establish factual accuracy. The report includes deterministic totals and findings separately so a human can compare them. The default request now asks for a focused ledger/bank pair check. Uploaded document contents are not read by the model, so file-content conclusions are unsupported. The Agent records a validation note when it makes one citation-repair request for missing citations; that revision remains inside the seven-round and five-minute bounds. Invalid citations or repeated omission still fail.

## Focused default request after correction

The focused default request completed on the corrected revision-14 data in run `5a160192-a9d1-405e-bbb8-8e80798e9ec6` (12:56:47–12:57:02 UTC). The model called `bank_reconciliation` and, after the one citation-repair request, correctly reported eight matching ledger entries, including LED-001/BANK-001 at SGD 7,000 and LED-008/BANK-008 at SGD 4,000. It recommended human review of dates and context. This request completed through the actual English UI and saved a separate draft.

UI verification also confirmed that uploading an existing evidence ID returns an explicit rejection and preserves the original file, and that editing a bank row records the before/after values and recalculates matches.

## Automated tests

The latest completed suite passed **35 tests**: 18 core tests and 17 backend integration tests. Run the following from the project folder with Node.js 24 or later:

```sh
npm test
npm run check
```

The tests cover integer-cent arithmetic, CSV handling, invalid and atomic imports, XLSX formulas and numeric-ID rejection, worksheet selection, preview revisions, database rollback and reopening, unique bank matches, payroll/ledger links, evidence persistence, role sequence, historical snapshots, Agent tool restrictions, citation rejection, local API request checks and interrupted-run recovery.

Agent protocol tests use controlled adapters to verify application behavior. They are distinct from the actual Ollama run above. Passing tests does not demonstrate live Bedrock access, authenticated users or legal compliance.

## File and UI checks

The linked examples contain six payroll records, eight ledger rows, eight bank rows and eight fictional supporting PDFs. An isolated in-memory verification imported all three XLSX files, confirmed exact stored PDF bytes for all eight files, obtained eight matches with zero findings, then reproduced and cleared the two findings caused by changing `BANK-003` between `4750.00` and `4950.00`.

The live UI anomaly correction and persisted revision change were separately observed as described above. Expected clean financial totals are:

| Metric | SGD |
| --- | ---: |
| Expected net payroll | 35,100.00 |
| Ledger income | 50,000.00 |
| Ledger expenses | 39,100.00 |
| Net cash movement | 10,900.00 |

Cash movement is calculated from the imported ledger. It is not a full accrual profit and loss statement.

The two focused successful runs are also retained in [the captured run examples](live-run-examples.json), including their actual tool results and generated text.

## Inspect or reproduce the evidence

In the existing test workspace, open **AI Agent** and find the completed `qwen3:4b-instruct` anomaly run. Expand its two tool traces, then inspect the corresponding revision-13 draft in **Reports & approvals**. **Export review JSON** includes saved source snapshots, report metadata and recent Agent runs; supporting file bytes are downloaded separately.

A fresh source installation starts with an empty database and does not include the private local test database or model weights. Follow [Getting started](../START_HERE.md) and [the demo script](DEMO_SCRIPT.md) to reproduce the scenario. A new run receives a different ID and may use different wording or tools. Compare every material statement with the source rows and deterministic findings.

## Not verified or implemented

- **AWS / Bedrock:** server adapter implemented; no account connection, live inference or deployed infrastructure verified.
- **Public access:** no public deployment URL or created GitHub repository URL is included.
- **Identity:** reviewer roles simulate the workflow; real sign-in and authenticated approval are absent.
- **Business integrations:** Teams scheduling, recruitment/MyCareersFuture, direct ERP/accounting sync, CPF and tax filing are not implemented.
- **Document analysis:** supporting files are stored and referenced; their contents are not extracted or read by the model.
- **AI reliability:** this targeted successful run establishes the working tool loop for the demonstrated scenario. It does not establish general financial accuracy, an audit opinion, or correctness for every prompt and dataset.
