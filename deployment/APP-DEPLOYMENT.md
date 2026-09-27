# PeopleLedger v2 — Vercel application preparation

The deploy root is `deployment/app`. This is an isolated copy of the current maintained `PeopleLedger-v2` source, not a replacement for it. `prepare-app.cjs` uses an explicit extension/directory allowlist and overlays only the cloud compatibility changes below. It never copies environment files, existing SQLite data, runtime evidence, node_modules, or other repository material. `SOURCE-MANIFEST.json` records the SHA-256 of source inputs before overlays.

## Build and verification

From the repository root, run `node deployment/prepare-app.cjs`. From `deployment/app`, run `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run build`, `pnpm run check`, and `pnpm test`. The committed lock pins dependencies, including the official `@vercel/blob` 2.8.0 SDK. The build publishes only eight enumerated frontend assets in `public`. It fails if an unexpected static file appears there. The Vercel API function includes server dependencies without exposing source files as static content. Preparation preserves existing `.env.local`, `.vercel` and project-link files; `.vercelignore` excludes `.env*` and `.vercel/` from the uploaded sources.

The application remains Node.js 24, CommonJS, the original API/services and `pg`. No Next.js or business-logic rewrite is required. The original source remains unchanged, including its existing uncommitted work.

## Persistence and configuration

This deployment requires PostgreSQL and, by default, a **private Vercel Blob store**. It also retains the existing AWS S3 option, requiring a bucket with public access blocked. It refuses SQLite, memory storage and local evidence storage. No `/tmp` persistence workaround is used. Missing configuration or a PostgreSQL initialization failure returns a generic `503 cloud_not_ready`, without database connection strings or cloud secrets. Storage initialization validates configuration; actual provider access must be verified through an upload and download.

Required environment variable names (values must be supplied privately in the hosting configuration):

- `DATABASE_URL` — PostgreSQL URL. Use TLS `sslmode=verify-full`, or omit the URL sslmode and allow the runtime's `PGSSLMODE=require` with certificate validation. Neon-provided `sslmode=require` URLs must be adjusted to `verify-full` for this prepared version.
- `BLOB_READ_WRITE_TOKEN` — connected **private**, not public, store.
- `SESSION_SECRET` — at least 32 characters.

For the alternative `EVIDENCE_DRIVER=s3`, replace the Blob token with `S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`; optionally `AWS_SESSION_TOKEN` and `S3_PREFIX`.

Other optional names: `BLOB_PREFIX`, `MODEL_DRIVER`, `BEDROCK_MODEL_ID`, `BEDROCK_GUARDRAIL_ID`, `BEDROCK_GUARDRAIL_VERSION`, `MAX_JSON_BYTES`, `EVIDENCE_MAX_BYTES`.

The entry point sets `NODE_ENV=production`, `DB_DRIVER=postgres`, `PGSSLMODE=require` and defaults `EVIDENCE_DRIVER` to `blob`. `MODEL_DRIVER` defaults to labelled `mock`; only `mock` and `bedrock` are allowed. Bedrock additionally requires the AWS credential names above. Local Ollama cannot be used from this cloud host. A configured Bedrock service still requires live verification.

For first setup, run **`node cloud-setup.cjs all`** from this prepared app, with the same private environment supplied locally. This explicitly runs migrations then the synthetic v2 seed; it never runs at HTTP startup. The individual `migrate` and `seed` actions are also supported. Seeding requires a **randomly generated `SEED_PASSWORD` of at least 32 characters**, injected through the environment. Generate it using a cryptographic random source or password manager; never publish its value or reuse the original local demonstration password. Existing seeded accounts are not password-reset by repeating seed. `reset` and unknown actions are rejected before opening the database. A transaction and PostgreSQL advisory lock serialize setup and roll back relational changes together. A failed seed can leave private content-addressed objects, which retries reuse after comparing the bytes; the script never deletes stored evidence. The seed password need not remain in the deployed application's environment after setup.

The Blob adapter uses server-side private `put`, `get` and `head`. It checks private-store metadata, refuses arbitrary external URLs and key traversal, limits payloads, validates SHA-256 content-addressed uploads, and verifies identical content on retries. SDK URLs and credentials are never returned by the adapter or included in browser downloads. Downloads continue through the existing authenticated, case-scoped evidence API. This does not claim provider-level WORM/object-lock retention; the application refuses overwrites and deletion.

## Cloud adaptations

- One initialization promise per function instance serializes simultaneous cold starts; a failed initialization is retryable. There is no permanent `server.listen` process.
- Login and logout cookies use Secure in production and retain HttpOnly/SameSite.
- The browser login page has no default password hint.
- Hidden controls remain hidden even when their button class sets `display`; the Finance preparer account hint uses the actual seeded account name.
- The raw body reader also accepts already-parsed Vercel JSON/Buffer bodies.
- Application upload and normal response payloads are capped at 4,000,000 bytes, below the platform 4.5 MB ceiling. Larger ZIP packages/downloads produce an explicit error and require a future authenticated object-storage download flow; they are not silently truncated. JSON/base64 uploads have less usable file capacity than raw uploads.
- PostgreSQL TLS validates server certificates.
- The CSP keeps scripts and styles same-origin. The workspace contains no inline scripts/styles/event handlers; three archived-demo inline styles were replaced with CSS classes. The existing API-then-Blob download uses a local download link and does not fetch a remote storage URL in the browser. The Vercel header pattern is `/(.*)`; JSON and binary API responses additionally set the strict CSP in the application itself.
- Static routing uses the server workspace at `/`, retains `/demo`, and rewrites `/api/*` to the common API entry.
- Max function duration is 180 seconds; region defaults to Singapore (`sin1`). Align the database and object store regions when provisioning.

## Local validation / remaining live checks

Original 116 regression tests plus 15 targeted cloud/Blob/setup tests passed (**131/131, zero failed/skipped**). These use isolated memory/temporary SQLite, model mocks, and an injected fake Blob SDK. The additional cases check fail-closed configuration, simultaneous initialization, private errors with retry, upload rejection before database initialization, pre-parsed request bodies, HTTPS cookies, download size errors, private storage calls, identical-content retries, access denial, secret sanitization, authenticated HTTP evidence downloads and non-destructive setup orchestration.

All **78** deployment JavaScript files passed syntax checks; the static build produced the eight allowlisted files. The installed official Blob SDK's `put`, `get` and `head` CommonJS exports loaded successfully.

An additional **22 real HTTP checks** passed using the serverless wrapper and identical CSP headers: static assets, metadata, unauthorized 401, login/Secure cookie, all overview data reads, ledger/bank/reconciliation reads, anonymous evidence denial, authenticated evidence bytes, CSV download, logout and session invalidation. The fixture used isolated synthetic memory data and temporary evidence. Result: `.presentation-build/cloud-http-smoke-result.json` at repository root. Browser automation was unavailable (no enabled browser surfaces), so actual browser clicks, rendering and browser-enforced CSP have **not** been verified by this task.

The parent deployment task connected Vercel, a Singapore Neon PostgreSQL database and a Singapore private Blob store, and completed three migrations plus the synthetic seed. This task then ran **24 real HTTPS functional checks** against the deployed app: PostgreSQL metadata, login with Secure/HttpOnly/SameSite cookies, preparer role restrictions, six employees/eight ledger entries/eight bank transactions, matching financial totals, overview reads, a six-record CSV export, anonymous evidence denial, authenticated private Blob bytes with a matching SHA-256, and logout invalidation. No business records or approval state were changed; normal session/download audit events were recorded. The private machine-readable report is `.deployment-tools/production-app-check.json`; it contains no passwords, cookies, tokens or account email addresses.

The initial live response lacked the expected static CSP header. The header pattern and API headers were corrected, alongside two login-page display issues; the 15 focused tests passed again. **Final acceptance against the new production deployment passed all 24 HTTPS checks**, including the strict CSP on the public workspace. The new deployment retained all six employees, eight ledger entries, eight bank transactions and nine private evidence files. A downloaded evidence file matched its recorded SHA-256. No additional header workaround was needed. Full workflow approval/package export was deliberately not exercised against production by this read-only check. The parent task controls browser acceptance; use only synthetic data.

## Official deployment references

- [Vercel Node.js runtime](https://vercel.com/docs/functions/runtimes/node-js)
- [Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
- [Vercel function limits](https://vercel.com/docs/functions/limitations)
- [Vercel project configuration](https://vercel.com/docs/project-configuration/vercel-json)
- [Marketplace PostgreSQL providers](https://vercel.com/docs/marketplace-storage)
- [Vercel Blob SDK, including private get and put](https://vercel.com/docs/vercel-blob/using-blob-sdk)
