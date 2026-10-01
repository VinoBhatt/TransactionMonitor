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

The workspace uses a shared password, an eight-hour HTTP-only session cookie,
server-side session revocation on logout, same-origin write checks, and sign-in
rate limiting. `APP_PASSWORD` is a Worker secret, never a frontend variable.
The API fails closed if the secret is absent. Reviewer names are entered by users;
this shared login does not establish individual reviewer identity or roles.

## Run locally

```bash
npm ci
```

Create an ignored `.dev.vars` file containing `APP_PASSWORD=<your-local-password>`.
A local development file may already exist; choose your own password in that file.

```bash
npm run db:migrate:local
npm run dev
```

Open `http://localhost:8787`. This serves both the application and API using local
D1. Wrangler rebuilds assets on startup. Restart after frontend changes.

## Cloudflare Workers deployment

`wrangler.jsonc` binds `DB` to `transactionmonitor-db`. That database has been
created and migration `0001_workspace.sql` applied remotely. No test data has been
uploaded to the remote database.

Before first deployment, set the shared password using the interactive prompt:

```bash
npx wrangler secret put APP_PASSWORD
npm run db:migrate:remote
npm run deploy
```

For Workers Builds use repository root `/`, leave the build command empty, and
keep deploy command `npx wrangler deploy`. Wrangler builds the frontend and Worker;
static assets come only from `dist/`. The Worker name is `transactionmonitor`.
Set `APP_PASSWORD` as a runtime Worker secret, not merely a build variable.
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

Further controls for a formal compliance system include individual authentication and roles, enforced monthly locking, a defined retention/backup policy, and user-ID-based investor matching. Sign-off currently records a conclusion without locking edits. The existing `xlsx` dependency has npm audit advisories; upgrading its distribution requires separate compatibility review.
