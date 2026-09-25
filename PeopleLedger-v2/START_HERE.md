# Start Here — PeopleLedger v2

This English version connects imported payroll, finance and bank files, stores supporting documents, and prepares reports for human review. Its AI Agent needs a running local model or a configured AWS account. File import and rule reports work before either is connected.

## 1. Open the complete application

Install Node.js 24 or later, extract the source ZIP, and run these commands inside the project folder:

```sh
npm ci
npm start
```

Open `http://127.0.0.1:4173`. Keep the server running while using the website. Double-clicking `dist/index.html` or uploading a static web ZIP will not run the backend.

Your records and uploaded files are saved in `data/peopleledger.sqlite` on this computer. Closing and reopening the browser does not erase them. This address works on the computer running the server; it is not a link you can send to other people for remote access.

## 2. Import the linked example files

Open **Data imports**. Select a dataset, choose the corresponding file, select **Preview import**, inspect the preview, then select **Confirm replacement**.

| Reviewer role | Dataset | Recommended example | Excel alternative |
| --- | --- | --- | --- |
| HR specialist | Payroll | `examples/payroll-corrected.csv` | `examples/payroll.xlsx` |
| Finance reviewer | Financial ledger | `examples/ledger-demo.csv` | `examples/ledger.xlsx` |
| Finance reviewer | Bank statement | `examples/bank-demo.csv` | `examples/bank.xlsx` |

The page also offers **Download CSV example** and **Download Excel example** for the selected dataset. Import one format per dataset; both formats contain the same clean demonstration data. The older `payroll-demo.csv` deliberately contains issues and is not the clean starting file.

## 3. Attach the eight fictional documents

Open **Evidence & history** and use **Download fictional example receipts**, or extract `examples/evidence-examples.zip`. Upload each PDF separately. Enter the filename without `.pdf` as its exact **Evidence reference**:

| Evidence references | Files |
| --- | --- |
| `PAY-202609-001` through `PAY-202609-006` | The six PDF files with those names |
| `INV-001` | `INV-001.pdf` |
| `RENT-001` | `RENT-001.pdf` |

Use the **HR specialist** or **Finance reviewer** role. Do not upload the ZIP itself. The six payment files are reused by the linked payroll and ledger rows. Uploaded evidence IDs cannot be overwritten; use a new ID and update source rows if replacing a document.

Open **Reconciliation**. The complete clean example should show eight matched ledger entries and zero findings. The PDFs are visibly fictional and demonstrate file linking only.

## 4. Run a real AI review

Install [Ollama](https://docs.ollama.com/quickstart) and use a local model that supports tools. No model API account is needed for local inference. The project adapter calls the local Ollama service; it does not download or launch a model itself.

For a terminal-managed Ollama service on macOS or Linux, start it with cloud features disabled:

```sh
OLLAMA_NO_CLOUD=1 OLLAMA_GO_TEMPLATE=0 ollama serve
```

Keep that process running. In another terminal, download the model:

```sh
ollama pull qwen3:4b-instruct
```

If the Ollama desktop app already runs the service, configure cloud features there and restart it instead of launching a second service. See [Ollama configuration](https://docs.ollama.com/faq#how-do-i-disable-ollama-cloud-features). The [qwen3:4b-instruct model page](https://ollama.com/library/qwen3:4b-instruct) lists the model details. This approximately 2.5 GB model was used for the verified anomaly review. `OLLAMA_GO_TEMPLATE=0` selects its built-in chat template in the tested Ollama 0.34.4 runtime; no custom-model compatibility script is needed. For a desktop-managed service, apply these environment settings to that service before restarting it.

In PeopleLedger:

1. Select **Finance reviewer** and open **AI Agent**.
2. Select **Refresh model connection**. Choose **Local · qwen3:4b-instruct**.
3. Leave the default request to check one ledger/bank pair, or ask about specific source IDs. Compare each answer against the displayed tool results.
4. Select **Run Agent**. Wait for **completed**, then inspect the displayed tool results and source references.
5. Open **Reports & approvals** to see the saved AI draft.

Model output and timing vary. If the run fails, read the error and check **Connections**. A visible model name means the model is available; a completed run verifies that it actually produced a tool-backed draft. On 25 September 2026, `qwen3:4b-instruct` used two tools to explain the SGD 200.00 mismatch between `LED-003` and `BANK-003`, cited both records and saved an AI draft. See [Validation evidence](docs/VALIDATION.md).

## 5. Review, approve and export

With zero findings and an up-to-date draft:

1. As **Finance reviewer**, select **Review & submit** and enter a note.
2. As **Director**, select **Approve** or **Return** and enter a note.
3. Select **Print / Save PDF** for the report.
4. Open **Evidence & history** and select **Export review JSON**. Download supporting files individually if needed; the JSON contains their metadata, not file bytes.

To demonstrate this workflow before the model is ready, select **Create rule report** in **Reconciliation**. That report is clearly labelled as deterministic and uses no AI. Changing source data after a report is created makes that report historical; generate a new report before further decisions.

## 6. Prepare deliverables 3 and 4

For **deliverable 3**, create a GitHub repository and upload the full project source, including `server/`, `dist/`, `package.json`, `package-lock.json`, tests and examples. Exclude installed dependencies, `.env`, databases and local model files. Give judges the required access and submit the repository URL. [GitHub upload instructions](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository).

For **deliverable 4**, record the working flow in [the demo script](docs/DEMO_SCRIPT.md), then provide the requested video file or accessible video URL. The supplied submission notice says “duration: 30mins”; confirm the organizer's exact length rule rather than assuming it is a maximum.

The current package does not include a public deployment or a created GitHub repository. Teams, recruitment, direct ERP synchronization, CPF and tax filing remain outside this version. See [AWS next steps](docs/AWS_NEXT_STEPS.md) for the account-dependent work.

## Local-model troubleshooting

Keep Ollama running while the Agent works. The five-minute timeout covers every model turn. Failed runs are retained in activity history and create no accepted AI report. Earlier tests with the original `qwen3:4b` thinking variant included failures; select the tested **`qwen3:4b-instruct`** model.

If Metal cannot initialize on the tested Mac, start the service in CPU mode:

```sh
OLLAMA_NO_CLOUD=1 OLLAMA_GO_TEMPLATE=0 LLAMA_ARG_DEVICE=none LLAMA_ARG_N_GPU_LAYERS=0 LLAMA_ARG_KV_OFFLOAD=0 LLAMA_ARG_FIT=off ollama serve
```

For a targeted anomaly demonstration after importing `bank-with-mismatch.csv`, use:

> Use bank_reconciliation to check LED-003 and BANK-003. In the final answer write the exact citations [ledger:LED-003] and [bank:BANK-003]. State the two recorded amounts, whether they matched, and recommend human review. Limit the answer to three sentences.

If the model returns an invalid citation or reaches a limit, the run fails explicitly. Shorten or clarify the request and retry. A successful demonstration does not guarantee every future model response will be correct.
