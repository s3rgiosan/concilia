# Concilia

A bank statement reconciliation desktop app for macOS that matches transactions from bank PDFs against receipts (PDF/JPG/PNG), sorts files into matched/review/unmatched folders, and exports an Excel report.

## Features

- **Local-only**: Single-user desktop app; the server binds to `127.0.0.1`, no auth, no cloud storage of your data
- **Multilingual**: English and Portuguese UI with user locale preference
- **Bank statement parsing**: Deterministic per-bank parsers (no AI) — currently CGD (extensible to other banks). All PDF I/O (statement parsing, receipt text extraction, receipt rendering for the Gemini vision fallback) goes through bundled poppler binaries (`pdftotext`, `pdftoppm`), shipped inside the .app.
- **Receipt extraction**: Google Gemini via Vertex AI extracts amount, currency, vendor, and issue date from receipts; service-account auth, low-confidence results retried up to 3×
- **Five-pass matching**: User rules → name+amount (EUR exact cents) → amount-only (EUR exact cents) → FX (±10%) → filename, with date-window tiebreaker
- **3-way sorting**: Receipts auto-moved into `_matched/`, `_review/`, `_unmatched/` on Finalize
- **Reimbursements**: Drop receipts paid personally on the company's VAT into `<year>/<month>/reimbursements/` — Concilia extracts them via the same Gemini pipeline (no matching attempted) and adds a dedicated sheet plus a totals row to the Excel report. Read-only in the UI with per-file rescan.
- **Review screen**: Inspect matches, accept/reject candidates, manually assign receipts, rescan a single receipt with Gemini. Filter the list by name, expand/collapse all rows in one click, and tell income from expense at a glance via a directional arrow (green ↗ income, red ↘ expense).
- **Pause / resume**: In-progress review decisions auto-saved (debounced) and restored on next launch
- **Excel export**: Multi-sheet workbook (`Totals`, `Validated`, `Matched`, `Review`, `Unmatched`, plus `Reimbursements` when present); status colour-coded; sheet names + column headers localized per app language
- **User-defined rules**: Bind receipt vendor substrings to transaction description substrings (Pass 0)
- **Per-receipt cache**: High-confidence extractions cached across runs to avoid duplicate Gemini calls

## Tech Stack

- **Desktop shell**: Electron + electron-store
- **Frontend**: React + TypeScript + Vite + react-i18next + Tailwind CSS + daisyUI + Lucide
- **Backend**: Node.js (Electron-as-Node) + Express
- **PDF parsing/rendering**: bundled poppler binaries — `pdftotext` (text) + `pdftoppm` (page → PNG)
- **AI extraction**: Google Gemini 2.5 Flash (Vertex AI), service-account JWT auth
- **Excel**: write-excel-file
- **Tests**: node:test (built-in)

## Project Structure

```text
concilia/
├── electron/         # Electron main, preload, config, setup wizard
├── client/           # React frontend (Vite → server/public/)
├── server/           # Express orchestration layer
├── parsers/          # Deterministic per-bank statement parsers
├── worker/           # Standalone CLI scripts (lib + bin)
├── tests/worker/     # node:test suite
├── build/            # electron-builder resources (icon, entitlements)
└── scripts/          # generate-icon.sh
```

## Getting Started

### Prerequisites

- macOS Apple Silicon (arm64)
- Node.js 22+
- npm 10+
- Google Cloud account with Vertex AI enabled (required for receipt extraction)
- For **building from source** only: [poppler](https://poppler.freedesktop.org/) (`brew install poppler`). The build script bundles poppler from your Homebrew install into the .app. Users of the released DMG do **not** need to install anything.

### Installation

```bash
git clone https://github.com/s3rgiosan/concilia.git
cd concilia
npm run build                    # install:all:prod + build:assets + electron-builder → dist-electron/
```

Unsigned arm64 DMG lands in `dist-electron/`. Open it and drag `Concilia.app` into `/Applications`.

First launch: macOS Gatekeeper blocks the unsigned app with a "Concilia is damaged and can't be opened" message. Strip the quarantine attribute to allow it:

```bash
xattr -dr com.apple.quarantine /Applications/Concilia.app
```

Then open normally. Only needed once per install.

### Development

```bash
npm run install:all              # root + server + worker + parsers + setup-css (incl. devDeps)
npm run build:assets             # build React + setup-css
npm run dev                      # launch Electron pointing at the local checkout
```

Vite dev server for fast frontend iteration (proxies to the Electron-hosted Express server):

```bash
cd client && npm install
npm run dev                      # http://localhost:5173
```

### Environment / Settings

Settings are stored in `~/Library/Application Support/Concilia/config.json` (chmod 600), edited via the gear icon in the navbar:

| Key | Default | Notes |
|---|---|---|
| `receiptsRoot` | — | Root folder containing `<year>/<month>/receipts/` subfolders |
| `saKeyPath` | — | Path to Vertex AI service-account JSON key |
| `geminiProject` | auto | Auto-detected from key file if blank |
| `geminiLocation` | `europe-west1` | Vertex AI region |
| `geminiModel` | `gemini-2.5-flash` | Vertex AI model ID |
| `language` | `en` | `en` or `pt` |

The config file stores a *path* to the SA key, not the key contents. Treat the file as sensitive.

PDF tooling resolves binaries from these environment variables (Electron main sets them to the bundled paths inside `Resources/poppler/bin/` for packaged installs):

| Var | Default | Notes |
|---|---|---|
| `PDFTOTEXT_BIN` | `pdftotext` on `PATH` | Used by the CGD parser AND the receipt text-extraction path |
| `PDFTOPPM_BIN` | `pdftoppm` on `PATH` | Used by the Gemini vision-fallback receipt rendering |

### Setting up Google Gemini (Vertex AI)

Concilia uses Google's Vertex AI (Gemini) to read receipts. You need a Google Cloud project with the Vertex AI API enabled and a service-account JSON key. Follow the steps below — the whole flow takes ~5 minutes.

#### 1. Create or select a Google Cloud project

1. Sign in to the [Google Cloud Console](https://console.cloud.google.com).
2. Click the project picker in the top bar → **New Project**.
3. Give it a name (e.g. `concilia`) and click **Create**.
4. Once created, make sure it's selected in the project picker — every subsequent step assumes this project is active.

> First-time Google Cloud users get a $300 free trial credit. After that, Vertex AI is pay-per-use (see pricing note at the bottom).

#### 2. Enable billing

Vertex AI requires a billing account, even though monthly cost is typically a few cents.

1. Go to **Billing** ([direct link](https://console.cloud.google.com/billing)).
2. Link a billing account to the project (create one if you don't have any).

#### 3. Enable the Vertex AI API

1. Open the Vertex AI API page: <https://console.cloud.google.com/apis/library/aiplatform.googleapis.com>.
2. Make sure your project is selected in the top bar.
3. Click **Enable**. Wait ~30 seconds for activation.

#### 4. Create a service account

1. Go to **IAM & Admin → Service Accounts** ([direct link](https://console.cloud.google.com/iam-admin/serviceaccounts)).
2. Click **+ Create service account**.
3. Fill in:
   - **Service account name**: `concilia` (or any name you like)
   - **Service account ID**: auto-fills (e.g. `concilia`)
   - **Description**: optional
4. Click **Create and continue**.
5. Under **Grant this service account access to project**, add the role:
   - **Vertex AI User** (`roles/aiplatform.user`)
6. Click **Continue**, then **Done**. You'll be returned to the service-accounts list.

#### 5. Generate a JSON key

1. In the service-accounts list, click your new account (e.g. `concilia@<project>.iam.gserviceaccount.com`).
2. Open the **Keys** tab.
3. Click **Add key → Create new key**.
4. Select **JSON** and click **Create**.
5. The browser downloads a `.json` file (e.g. `concilia-abc123.json`). **Save this file in a safe location** — e.g. `~/.config/concilia/sa-key.json`. You can't re-download it; if lost, generate a new key.

> Treat this file as a password. Anyone with it can call Vertex AI on your billing account. Don't commit it to git, don't email it.

#### 6. Point Concilia at the key

- During the first-launch wizard, click **Browse…** next to the SA key field and select the `.json` file you just saved.
- Or later, open Settings (gear icon in the navbar) and update **Service account key**.

The Project ID, Location and Model fields can stay blank/default — Concilia auto-detects the project from the key file and uses `europe-west1` + `gemini-2.5-flash` by default.

#### Pricing & privacy

Vertex AI is pay-per-use. Gemini 2.5 Flash costs ~$0.10/1M input tokens. ~200 receipts/month ≈ $0.04. Data sent to Vertex AI is **not used to train Google models** under the Vertex AI terms — see [Vertex AI pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing) and [data governance](https://cloud.google.com/vertex-ai/generative-ai/docs/data-governance).

## Usage

1. **Drop receipts** into `<receiptsRoot>/YYYY/MM/receipts/` (PDF, JPG, PNG)
2. **Open Concilia** and complete the first-launch wizard (receipts folder + SA key)
3. **Select Year and Month** in the form
4. **Upload bank statements** — one or more PDFs, selecting the bank for each
5. **Click Run Reconciliation** and watch live SSE progress
6. **Open the Review screen** to inspect matches:
   - Filter by status (All / Review / Unmatched / Matched) plus a name filter that narrows by description substring
   - Expand or collapse all visible transactions in one click
   - Income vs. expense at a glance — green ↗ on positive amounts, red ↘ on negative
   - 👁 Preview a receipt
   - 🔄 Rescan a receipt with Gemini
   - ✓ Accept / ✗ Reject candidates, manually assign receipts to unmatched transactions
7. **Save** intermediate work (draft is auto-saved every 500 ms; Save button forces an immediate flush). **Scan** when you add or remove receipt files to re-extract and re-match without losing review state. **Download Report** at any time — the .xlsx reflects pending decisions (draft merged onto match results).
8. **Click Finalize** (with confirmation) to move files into 3-way folders, regenerate the report, and clear the draft. Irreversible.

Folder layout after processing:

```text
<receiptsRoot>/2024/12/
├── receipts/
│   ├── _matched/         ← Matched receipts (send to accountant)
│   ├── _review/          ← Ambiguous matches (needs manual review)
│   ├── _unmatched/       ← Unmatched receipts
│   └── (any new receipts dropped here for the next run)
├── reimbursements/        ← Receipts paid personally on company VAT (optional)
└── docs/                  ← Reports and data
    ├── report.xlsx
    ├── transactions.json
    ├── receipts.json
    ├── reimbursements.json (when reimbursements/ has files)
    └── match-result.json
```

## Supported Banks

- **CGD (Caixa Geral de Depósitos)** (Portugal)

### Adding Support for New Banks

The project uses a simple registry pattern — 3 files need to be touched (+1 optional for tests):

1. Create `parsers/<bank-slug>.mjs` exporting `async function parse(buffer)`
2. Register it in `parsers/parse.mjs` (1 line in the `parsers` registry)
3. Add the bank option to the `BANKS` array in `client/src/components/ReconcileForm.tsx` (1 line)
4. (Optional) Tests in `tests/worker/<bank-slug>.test.js`

See [`.github/BANK_PARSER_GUIDE.md`](.github/BANK_PARSER_GUIDE.md) for the full contributor guide. `parsers/cgd.mjs` is a reference implementation.

## API Endpoints

The Express server listens only on `127.0.0.1` (single-user, no auth).

### Reconciliation

| Method | Endpoint | Description |
|---|---|---|
| POST | /api/reconcile | Multipart upload (statements + banks + year + month) → SSE progress stream |
| GET | /api/status/:year/:month | `{ exists, applied }` for resume/badge UX |
| GET | /api/busy | `{ busy }` — true if a reconcile/rescan is in flight |

### Review & Drafts

| Method | Endpoint | Description |
|---|---|---|
| GET | /api/review/:year/:month | Review data (transactions + unmatched receipts) |
| POST | /api/review/:year/:month | Finalize: apply manual corrections, move files, regenerate the report, clear draft |
| POST | /api/scan-receipts/:year/:month | Re-walk receipts folder, extract new files, drop removed, re-match. SSE stream. |
| GET | /api/draft/:year/:month | Pending Accept/Reject/Assign decisions |
| PUT | /api/draft/:year/:month | Auto-save draft (debounced from client) |
| DELETE | /api/draft/:year/:month | Discard draft |
| POST | /api/rescan-receipt/:year/:month | Re-run Gemini extraction on a single receipt |
| POST | /api/rescan-reimbursement/:year/:month | Re-run Gemini extraction on a single reimbursement receipt |

### Rules

| Method | Endpoint | Description |
|---|---|---|
| GET | /api/rules | List user-defined match rules |
| PUT | /api/rules | Update match rules |

### Files

| Method | Endpoint | Description |
|---|---|---|
| GET | /api/receipt/:year/:month/* | Stream a receipt file (sandboxed under `receipts/` or `reimbursements/`) |
| GET | /report/:year/:month/report.xlsx | Download Excel report |

## Excel output

Multi-sheet workbook (sheet names + headers localized per app language):

- **`Totals`** — aggregate rows: signed sum of MATCHED transactions tagged "no receipt", sum of unmatched receipt amounts, and (when present) sum of reimbursements.
- **`Validated`** — one row per transaction with status colour, receipt names, amounts, confidence, currency, notes. Status column colour-coded: green (MATCHED), amber (REVIEW), red (UNMATCHED).
- **`Matched`** / **`Review`** — one row per receipt attached to MATCHED / REVIEW transactions, carrying the parent transaction's date/description/amount.
- **`Unmatched`** — one row per receipt that didn't match any transaction.
- **`Reimbursements`** — one row per receipt under `reimbursements/`, plus a TOTAL row. Sheet appears only when reimbursements exist; it is independent of the matcher.

Validated sheet (excerpt):

| date | description | amount | status | receipt_file(s) | receipt_amount | receipt_confidence | receipt_currency | notes |
|---|---|---|---|---|---|---|---|---|
| 2024-12-15 | COMPRA SHOPCO | -45.99 | MATCHED | receipt.pdf | 45.99 | high | EUR | name_amount_match |
| 2024-12-16 | RESTAURANTE X | -23.50 | UNMATCHED | | | | | |
| 2024-12-17 | COMPRA Y | -50.00 | REVIEW | a.pdf; b.pdf | 50.00; 50.00 | high; high | EUR; EUR | 2 receipts match amount |
| 2024-12-18 | COMISSÃO | -2.50 | MATCHED | | | | | bank_fee |

## Matching

Five-pass matching with date-window tiebreaker, **exact cents** for EUR↔EUR (no tolerance), **±10% for FX** (non-EUR receipts), 3-way sorting:

- **Pass 0 — User rules**: vendor substring → transaction description substring
- **Pass 1 — Name + amount (EUR)**: filename or vendor matches description AND amount equals tx amount exactly; bank-fee patterns auto-MATCHED
- **Pass 2 — Amount only (EUR)**: amount equals tx amount exactly; name overlap disambiguates multiple candidates
- **Pass 3 — Foreign currency (±10%)**: always REVIEW (human verifies FX)
- **Pass 4 — Filename**: vendor name in receipt filename; always REVIEW
- **No matches** → UNMATCHED

## Logs

`~/Library/Logs/Concilia/server.log` (rotates at 5 MB).

## Testing

```bash
npm test                                    # Run all worker tests
node --test tests/worker/matcher.test.js    # Single file
```

Uses Node.js built-in `node:test` and `node:assert`. Zero npm test dependencies (other than `exceljs` for Excel verification, a worker devDep).

## License

[GPL-3.0-or-later](LICENSE)
