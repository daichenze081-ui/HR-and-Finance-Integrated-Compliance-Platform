# PeopleLedger: English narration

20 slides. Automatic presentation duration: 19 minutes 11 seconds.

English slides with synthetic English narration. All people and transactions in the demonstration are fictional.

## 1. HR and Finance Review Platform

Project demonstration

Welcome to the PeopleLedger project demonstration. PeopleLedger brings human resources and finance records into a shared review process. The project focuses on a practical question: how can a reviewer understand a decision and find the records that supported it? During this presentation, we will follow a sample case from data preparation through checks, bank reconciliation, approval, and evidence export. We will also look at recruitment and the limits placed on AI assistance. All people and transactions in this demonstration are fictional. The product screenshots come from an isolated local demonstration. A cloud edition is now available on Vercel, with a PostgreSQL database and private file storage. This presentation explains the implemented behaviour, the evidence from testing, and the work still needed before an organisation could rely on it for operational use.

## 2. Gaps in cross-functional review

The business problem behind the project

A review becomes difficult when each department maintains a different part of the evidence. Human resources may own the payroll spreadsheet. Finance may hold the ledger, while bank transactions arrive in a separate file. Even when each file is reasonable on its own, comparing them takes effort. A second problem appears when someone edits the underlying data after a report has circulated. The report may continue through approval without making that change obvious. A third problem concerns accountability. An approval message by itself does not explain which evidence the approver saw. PeopleLedger addresses these problems by organising records around a case, preserving source snapshots in reports, and recording the people who perform each review step. The intended benefit is a review that colleagues can follow and revisit. The project has not measured time savings in a real organisation.

## 3. The maintained version

Changes since the earlier browser prototype

The maintained second version makes several changes to the earlier browser prototype. Data now belongs to a server application, so closing or refreshing a browser does not define the lifetime of the business records. The original local edition uses SQLite, and the deployed edition uses PostgreSQL. Access also changes from a simulated role selector to authenticated accounts with server permissions. The scope of the inputs expands beyond payroll to include ledger and bank records. Evidence develops from a reference number into an actual file with a version and a recorded hash. These changes matter because a demonstration becomes more useful when the server enforces the workflow. A browser can guide a user, but the server must decide whether an action is allowed. The rest of the presentation shows how these capabilities work together in one sample case.

## 4. The review workflow

Four stages organise the case

The workflow has four broad stages. First, a user prepares the case by importing the required records and attaching supporting evidence. The system validates the data before accepting the import. Second, checks identify issues and bank reconciliation compares the ledger with the bank statement. These results help a reviewer decide what still needs attention. Third, the report captures the relevant data and moves through separate review and approval stages. This is where the system records who made each decision and prevents users from skipping the required steps. Finally, an authorised user seals the approved report and exports its evidence package. Sealing creates a defined review outcome that can be revisited later. These stages provide the structure for the demonstration. Each screen has a specific place in the process, rather than acting as an unrelated collection of features.

## 5. The sample case

September 2026 demonstration data in Singapore dollars

The sample case contains six fictional employees. The ledger has eight transactions, and the bank file also has eight. Six salary payments total thirty-five thousand one hundred Singapore dollars. A rental payment adds four thousand dollars to the outflow. A sales receipt contributes fifty thousand dollars of inflow. The chart therefore shows fifty thousand dollars of inflow, thirty-nine thousand one hundred dollars of outflow, and ten thousand nine hundred dollars of net bank movement. Net bank movement does not establish accounting profit. The payroll records also distinguish gross pay from net pay. Gross pay totals forty-three thousand eight hundred dollars, while expected and paid net salary both total thirty-five thousand one hundred dollars. Keeping those concepts separate avoids an incorrect comparison between gross payroll and the salary transactions that actually reach employees. All amounts here belong to synthetic demonstration data.

## 6. A shared case workspace

Actual application screen with fictional records

The case overview provides an entry point for the reviewer. Instead of starting with several unrelated files, a user opens a case and can see the records and review status associated with it. The screenshot shows the actual application with fictional sample data. The overview helps answer basic questions: which case am I reviewing, what information has been prepared, and what remains to be done? The surrounding navigation leads to the detailed payroll, reconciliation, report, and evidence views. Access depends on both the user role and the case membership checked by the server. This matters when several teams share one application, because a person who can sign in should still see only the cases and actions permitted for that account. The overview supports navigation and coordination. The detailed evidence remains available in the relevant working screens.

## 7. Import validation and payroll

Preview records before confirming an import

Importing a spreadsheet is a point where errors can enter the workflow, so the application checks the input before committing it. The preview lets the user examine the proposed records and resolve problems before confirming the import. The implementation supports the project’s CSV and spreadsheet input paths, validates required values, and rejects spreadsheet formulas in the supported import flow. It also treats an import as a complete operation, so invalid input should not leave a partly updated business dataset. Money uses integer cents inside the calculations. For example, one hundred dollars and twenty-five cents becomes ten thousand and twenty-five cents. This avoids the small rounding surprises that ordinary binary decimal calculations can introduce. The demonstration expects Singapore dollars explicitly. These choices support reliable comparisons when payroll totals later connect to ledger records and bank transactions.

## 8. Checks and issue handling

Deterministic rules produce reviewable findings

The checks screen applies fourteen default demonstration rules. These checks are deterministic, which means the same inputs and rule definitions produce the same findings. That makes the results easier to explain and test. In the corrected sample case, the results show zero blocking issues and six items that still need manual review. The six items concern the payroll PDF evidence. The application can store the files and record their identity, but it does not read and verify every statement inside those documents. A human reviewer still needs to inspect them. Zero blockers therefore does not mean that every business assertion has been independently proven. It means the implemented blocking checks did not find a blocking condition in this sample. The rules demonstrate a review framework and require professional validation before they could represent a real organisation’s compliance requirements.

## 9. Bank reconciliation

One-to-one matching between ledger and bank records

Bank reconciliation connects the internal ledger to the external bank record supplied for the case. The matching logic uses the reference, the amount, and whether the transaction is an inflow or an outflow. It also enforces one-to-one matching. A single bank transaction should not satisfy several ledger entries simply because they share a similar description. In the corrected demonstration, all eight ledger transactions match the eight bank records. This is a useful result for the sample, but it is not a claim that every possible bank statement will reconcile automatically. The current implementation uses explicit matching criteria instead of fuzzy matching. When a reference differs, an amount is wrong, or a record is missing, the reviewer must resolve the discrepancy. This approach makes the reasons for a match easier to understand and makes unmatched records visible for follow-up.

## 10. Report snapshots

The report preserves the records used in the review

A report is valuable only if a reviewer can understand what it represents. PeopleLedger therefore preserves the relevant source data when it creates the report. The snapshot includes payroll, ledger and bank records, as well as import context and reconciliation results. It also records the applicable rules and evidence references. If someone changes the working case later, an earlier report should continue to describe its original basis. This prevents a historical review from silently inheriting today’s numbers. The implementation also avoids filling a missing historical snapshot with current data as though that data had existed at the time. That distinction matters when investigating a difference between two versions. Reviewers can discuss a specific report and its supporting information, while new work can proceed in the case. The report becomes a defined record of a review stage.

## 11. Separate review and approval

The server enforces the order and the actors

The approval process separates submission, finance review, management confirmation, and director approval. These stages require different actors, so one person cannot complete all of the decision steps for the same report. The server also rejects attempts to skip stages. For example, a director cannot approve a report that has not reached the required prior state. After approval, an authorised director can seal the report. The sealing action can belong to the same director who approved it, so the four-actor requirement concerns the four decision stages rather than five separate people. This distinction is useful when explaining the implementation. The workflow helps preserve responsibility and the sequence of decisions. It does not guarantee that an approver exercised good judgment. The reviewer must still inspect the available evidence and record a decision that the organisation can defend.

## 12. Evidence files and exports

Files retain their versions and recorded hashes

Evidence handling connects a report to actual files. The application records the source and version of an uploaded document and calculates a SHA-256 hash for its bytes. A later comparison can use that hash to detect whether those bytes differ. A matching hash does not prove that the statements in the document are true, or that the person who supplied it was authorised to make them. Those questions remain part of human review. The sample evidence inventory contains nine files, including eight PDFs requiring manual review and one readable advertisement. An export packages the report with the relevant supporting material so a reviewer can inspect them together. In the cloud edition, evidence resides in private Blob storage and the application checks access before serving it. The current serverless deployment also limits individual requests and uploads to four megabytes.

## 13. Activity and accountability

Actions remain connected to people and report versions

The activity trail helps a reviewer reconstruct how a case reached its current state. It records the actor and timing for relevant actions and connects those actions to the report or business operation. This is useful when someone asks why a report moved forward, who reviewed it, or which version existed at a particular point in the workflow. The server also records access-related activity and checks role permissions. Auditor access can have a limited duration, which supports a review assignment without assuming permanent access. These capabilities provide accountability within the application. They should not be described as an independently certified, tamper-proof archive. A production organisation would still need appropriate administration, retention policies, and operational controls. For this project, the main outcome is that review activity and historical report versions can be followed through the application instead of relying only on separate messages.

## 14. Recruitment and onboarding

Candidate progress connects to essential employee records

The human resources side also includes recruitment. A case can hold job requirements and track candidates through the supported stages. The implementation checks the required conditions for transitions, rather than treating every stage as an unrestricted label. Candidate evaluation uses scorecard versions so that a later change to the assessment does not erase the context of an earlier decision. After the required hiring steps, the onboarding flow creates essential employee information for the next part of the process. This demonstrates the connection between recruitment records and downstream human resources work. The screenshot also includes interview scheduling actions. Those actions currently simulate the meeting workflow. They do not demonstrate a live Microsoft Teams invitation or a production Microsoft Graph connection. A real integration would need authorised access, failure handling, and tests that confirm meeting creation and changes in the external service.

## 15. AI assistance and its limits

The default demonstration uses a Mock model

The AI assistant supports the review process within explicit limits. It can read the information made available to its tools and save a draft for a person to examine. It cannot make payments, approve a report, or change the source records and rules that determine a review outcome. It also cannot grant itself permissions or delete the evidence. These restrictions keep the important decisions in the application workflow and with authorised people. The current default is a Mock model, which makes the demonstration predictable. The repository contains adapters for other model services, but their presence is not evidence that a live model has been evaluated in this deployment. A future rollout would need to test the chosen service with representative cases, including missing evidence and misleading instructions inside uploaded material. Human reviewers remain responsible for accepting, correcting, or rejecting a draft.

## 16. Implementation and cloud deployment

A local reference edition and a deployed cloud edition

The browser workspace uses HTML, CSS, and JavaScript. A Node.js application exposes the APIs and checks sessions and permissions. The business services implement the rules, reconciliation, report snapshots, and approval transitions shown earlier. The original local edition stores records in SQLite and keeps evidence files locally. The cloud edition now runs on Vercel, uses a Neon PostgreSQL database in Singapore, and stores evidence in private Vercel Blob storage. These are distinct deployment arrangements for the same demonstrated business process. The cloud application and the presentation website have separate public addresses. Signing in to the application still requires the appropriate account. Credentials are not included in these presentation downloads. The project currently uses a manual deployment process. Saving a local file does not automatically update the live website. These details describe the delivered setup, rather than a promise of unlimited scale or enterprise readiness.

## 17. Verification results

Local baseline and cloud deployment checks

The original local project passed one hundred and sixteen automated tests, and seventy-one source files passed syntax checks. That is the baseline used for the application demonstration. The deployment edition subsequently passed one hundred and thirty-one automated tests and checks of seventy-eight JavaScript files. A further set of twenty-four live HTTP checks passed against the deployed application. Those live checks covered practical behaviour such as authentication, permissions, persistent records, and private evidence retrieval. The sample records remained available after redeployment, which helps confirm that the cloud application uses persistent storage. These different checks answer different questions. Automated tests cover defined behaviour in a controlled environment. Live checks confirm selected behaviour in the deployed environment. Neither result establishes complete security or statutory compliance. The next stage should add user acceptance and operational testing with appropriate business reviewers.

## 18. Current boundaries

Implemented behaviour and work still required

This table separates the implemented capabilities from the remaining work. The fourteen demonstration rules show how checks can operate, but specialists must validate the rules for a real business and jurisdiction. The assistant uses a Mock model, so a live service still needs evaluation. Interview scheduling demonstrates the process, while Microsoft Graph integration remains future work. Evidence files have versions and hashes, but document content still needs human review, and optical character recognition is an optional future addition. Cloud deployment is now complete for this demonstration, with PostgreSQL and private file storage. Organisational operation still needs decisions about single sign-on, backup and recovery, security review, and monitoring. The application’s four-megabyte request limit also constrains large evidence uploads and exports. Stating these boundaries helps an audience distinguish a working project demonstration from a service that has completed a full production readiness process.

## 19. The next stage

Recommended work before an operational pilot

The recommended next stage begins with business acceptance. Human resources and finance reviewers should examine the sample workflow and confirm that the required fields, rules, and approval stages fit their actual responsibilities. The second priority is operational readiness. The team should test identity management and perform a recovery exercise, rather than assuming that a database backup alone guarantees restoration. External services should then be connected one at a time, with clear success and failure cases for each integration. A controlled pilot can assess whether the application improves the review process. Useful measures might include the time needed to locate supporting evidence, the number of unresolved reconciliation items, and the frequency of reports returned for correction. These are proposed evaluation measures, not results already achieved by the project. The pilot should use agreed criteria and appropriate data handling arrangements before any broader adoption.

## 20. Project recap and discussion

PeopleLedger

PeopleLedger now demonstrates a complete review process using fictional human resources and finance data. The case connects imports with deterministic checks and bank reconciliation, then preserves the source records in a report that passes through separate approval stages. Evidence files and an activity trail help reviewers understand the decisions afterwards. Recruitment and the restricted assistant extend the demonstration while keeping their current integration limits visible. The application is available on Vercel with persistent database and private file storage, and this presentation provides an English explanation of the delivered work. The testing results support the specific behaviours that were checked. Further business and operational validation remains necessary before real organisational use. Thank you for watching. The presentation website provides the editable PowerPoint, the automatic slideshow, and the narration script. These materials can support a project assessment, a demonstration session, or a discussion of the next development stage.
