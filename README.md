# Cofundr Transaction Monitoring — Base Web V2

A React/Vite application backed by a Cloudflare Worker and D1 for monthly Cofundr compliance transaction monitoring and the Appendix II Staff Investment Report. No R2 is used.

## V2 improvements based on existing Cofundr working files

V2 can use the historical **ACTIVE INVESTORS & ISSUERS** workbook as a reference source. It recognises sheets such as:

- `Monthly Deposit '24 / '25 / '26`
- `Monthly Investment Commited '24 / '25 / '26`
- `Monthly Gross Withdrawal '24 / '25 / '26`
- `Risk Profile ...`
- `Account Balances Sheet`

This allows the review queue to show Investor ID, AML risk profile, historical average deposits, historical maximum deposits, and historical activity context beside the current-month flag.

V2 can also import the earlier **Flagged Transaction Monitoring** workbook and carry forward non-empty `Compliance Comments` as prior context. These are displayed as historical context only and do not automatically clear a new flag.

## Core controls

- Upload Cofundr Admin Panel transaction log (`.xlsx`, `.xls`, `.csv`).
- Mandatory **TM-001**: aggregate `Deposit` transactions by investor and calendar month; flag when total is **strictly greater than RM30,000**.
  - RM30,000.00 exactly is not flagged.
  - RM30,000.01 and above is flagged.
  - This rule is fixed and cannot be disabled or edited.
- Optional rules:
  - TM-002 Single Large Deposit.
  - TM-003 Deposit Frequency.
  - TM-004 Rapid Deposit / Withdrawal.
  - TM-005 High-Risk Customer Deposit, using the historical AML risk profile.
  - TM-006 Historical Deposit Spike versus the investor's prior positive-month average.
- Compliance review queue with decision, reviewer and comments.
- Staff selection from an investor dropdown and matching against `Investment Committed` transactions. The list combines uploaded transactions and historical investor profiles; selections are saved in D1 and can be removed individually.
- Note Master upload and mapping from Note ID to Note Reference ID / Note Name.
- Appendix II monthly Staff Investment Report.
- Excel report export and browser Print / Save PDF.
- Monthly Compliance Sign-Off screen.

## Storage and authentication

The Worker serves `/api/*` and the built React application. D1 stores transactions
by month, historical investor profiles, selected staff, note references, prior
compliance context, monitoring rules, review decisions, and monthly sign-offs.
Spreadsheets are parsed in the browser; only structured records are sent to D1.
There are no R2 bindings, buckets, or file uploads.

Imports are uploaded in bounded chunks and become visible only after every row
has been validated and the import is committed. Replacing a month's transactions
keeps other months and resets that month's reviews and sign-off. Multi-month
files commit each month separately; if one fails, earlier committed months stay
saved. A version check rejects conflicting writes instead of overwriting another
browser's changes. Use Refresh after a conflict. Prior committed revisions and
an append-only save log are retained in D1; expired incomplete imports currently
require administrator cleanup.

The workspace uses individual accounts with Admin, Compliance Officer, and Chief
Compliance Officer roles. All three can read records, upload data, select staff,
and save reviews. Only Admin and Chief Compliance Officer can change rules or
save monthly sign-offs. The API enforces these permissions and records the
signed-in user in the audit log and reviewer fields.

Passwords are salted and hashed with PBKDF2-SHA256 and a separate `AUTH_PEPPER`
Worker secret. Production accounts start with randomly generated temporary
passwords and must change them before accessing records. Password changes require
the current password, a new password of at least 16 characters, and revoke all
sessions for that account. Sessions expire after eight hours; logout revokes the
session immediately. Same-origin writes and sign-in/password rate limits apply.
There is no public registration or shared-password fallback.

## Run locally

```bash
npm ci
```

Create an ignored `.dev.vars` file containing a random `AUTH_PEPPER` value of at
least 32 characters. Account password hashes must be generated with that same
pepper. The Playwright suite seeds isolated test accounts automatically; it does
not alter development or production users.

```bash
npm run db:migrate:local
npm run dev
```

Open `http://localhost:8787`. This serves both the application and API using local
D1. Wrangler rebuilds assets on startup. Restart after frontend changes.

## Cloudflare Workers deployment

`wrangler.jsonc` binds `DB` to `transactionmonitor-db`. That database has been
created and migrations `0001_workspace.sql` and `0002_user_accounts.sql` applied remotely. No test data has been
uploaded to the remote database.

Production account setup uses `scripts/prepare-production-users.mjs` to generate
three users and ignored files under `private-data/production-accounts/`. Never
rerun account preparation to reset passwords or rotate the pepper; existing
password hashes depend on it. Store the pepper securely with database backups.

Initial setup (already performed for this workspace once deployed):

```bash
node --experimental-strip-types scripts/prepare-production-users.mjs
npm run db:migrate:remote
npx wrangler secret bulk private-data/production-accounts/secrets.json
npx wrangler d1 execute DB --remote --file private-data/production-accounts/accounts.sql
npm run deploy
```

`credentials.md` in that ignored directory contains the initial passwords for
`admin`, `compliance`, and `chiefcompliance`. The production credentials are not
committed to Git, printed to build logs, or included in frontend assets.

For Workers Builds use repository root `/`, leave the build command empty, and
keep deploy command `npx wrangler deploy`. Wrangler builds the frontend and Worker;
static assets come only from `dist/`. The Worker name is `transactionmonitor`.
Keep `AUTH_PEPPER` as a runtime Worker secret, not a build variable.
For future schema changes, apply reviewed migrations before deploying dependent code.

```bash
npm run deploy:check
```

See [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
and [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).

## Validation

```bash
npx playwright install chromium
npm test
```

Tests start a local Worker with an isolated temporary D1 database under `.wrangler/`.
They verify authentication, upload validation, incomplete-import isolation,
conflict rejection, the mandatory threshold, staff matching, and persistence
across refresh and login. They do not use the remote database.

Run `npm run types` after changing bindings; generated types are committed for CI.

## Recommended monthly workflow

1. Upload the current monthly Admin Panel transaction export.
2. Upload the historical ACTIVE INVESTORS & ISSUERS workbook for AML / historical context.
3. Upload the previous monitoring workbook if you want prior Compliance Comments carried forward.
4. Under Monthly Upload, select staff members from the Staff Register investor dropdown. No separate staff document is needed.
5. Upload the Note Master.
6. Review all flags, especially TM-001.
7. Generate the Monthly Deposit Monitoring Report and Appendix II Staff Investment Report.
8. Complete the monthly Compliance sign-off.

## Privacy / GitHub

Do not commit real transaction logs, investor files, staff files or note-master files into Git. The project `.gitignore` includes `private-data/` for this reason.

Original workbook files are not stored. Imported records and reference data are saved in D1. Browser-only data from the earlier version is not automatically uploaded; reimport reference files and select staff again when moving to the shared workspace.

## Production hardening still recommended

Further controls for a formal compliance system include named employee account assignment, enforced monthly locking, a defined retention/backup policy, and user-ID-based investor matching. Sign-off currently records a conclusion without locking edits. The existing `xlsx` dependency has npm audit advisories; upgrading its distribution requires separate compatibility review.
