# Cofundr Transaction Monitoring — Base Web V2

A local-first React/Vite prototype for monthly Cofundr compliance transaction monitoring and the Appendix II Staff Investment Report.

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
- Staff Register upload and matching against `Investment Committed` transactions.
- Note Master upload and mapping from Note ID to Note Reference ID / Note Name.
- Appendix II monthly Staff Investment Report.
- Excel report export and browser Print / Save PDF.
- Monthly Compliance Sign-Off screen.

## Run locally

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal, normally `http://localhost:5173`.

## Production build

```bash
npm run build
npm run preview
```

## Cloudflare Workers deployment

The application source must be committed at the repository root. Cloudflare does
not extract the original ZIP archive during builds.

Use these Workers Builds settings:

- Root directory: repository root (`/`).
- Build command: leave empty; Wrangler runs `npm run build` through its configuration.
- Deploy command: `npx wrangler deploy`.
- Worker name: `transactionmonitor` (change `name` in `wrangler.jsonc` if your existing Worker has a different name).

Cloudflare installs dependencies from `package.json` and `package-lock.json`.
Wrangler then builds the React app and deploys only `dist/` as static assets with
single-page application routing.

To validate locally without publishing:

```bash
npm ci
npm run deploy:check
```

See the [Wrangler configuration documentation](https://developers.cloudflare.com/workers/wrangler/configuration/).

## Recommended monthly workflow

1. Upload the current monthly Admin Panel transaction export.
2. Upload the historical ACTIVE INVESTORS & ISSUERS workbook for AML / historical context.
3. Upload the previous monitoring workbook if you want prior Compliance Comments carried forward.
4. Upload or maintain the Staff Register.
5. Upload the Note Master.
6. Review all flags, especially TM-001.
7. Generate the Monthly Deposit Monitoring Report and Appendix II Staff Investment Report.
8. Complete the monthly Compliance sign-off.

## Privacy / GitHub

Do not commit real transaction logs, investor files, staff files or note-master files into Git. The project `.gitignore` includes `private-data/` for this reason.

The transaction and historical workbooks are held only in browser memory in this prototype. Staff, note-master and prior-context reference records can persist in browser `localStorage`.

## Production hardening still recommended

Before this becomes a formal production compliance system, add authentication/roles, a database, server-side immutable audit logs, monthly locking, backups, retention controls, user-ID-based investor matching, and controlled report generation.
