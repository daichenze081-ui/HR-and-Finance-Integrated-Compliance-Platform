# Start PeopleLedger

Requires Node.js 24+. Run `npm ci`, `npm run seed`, then `npm start`. Open http://127.0.0.1:4173.

Sign in as `preparer@peopleledger.demo` with SEED_PASSWORD (default `Demo!Passw0rd`). Select the v2 sample case. Eight ledger and bank rows match; supporting PDFs require human content review. Use separate accounts for HR editing and the approval stages.

SQLite preserves data across restarts. Seed never resets an existing case. See [README.md](README.md) for accounts, import formats and optional connections.
