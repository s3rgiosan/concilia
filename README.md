# Concilia

Bank statement reconciliation desktop app for macOS. Deterministic parsers extract transactions from bank statement PDFs; Google Gemini extracts amount, currency, vendor, and date from receipts. Matches transactions against receipts, sorts files into 3-way folders, and produces an Excel report. Includes a Review screen for manual corrections and per-receipt AI rescan.

## What it does

1. Extracts transactions from one or more bank statement PDFs (deterministic parser)
2. Reads receipt files from `<year>/<month>/receipts/` (PDF, JPG, PNG)
3. Extracts amount, currency, vendor, and issue date from each receipt using Google Gemini (Vertex AI). Retries up to 3 times on transient failures.
4. Matches transactions to receipts (±€0.05 EUR, ±10% FX) using a five-pass algorithm: user rules → name+amount → amount-only → FX → filename, with date-window disambiguation
5. After user clicks **Apply Changes** in the Review screen, sorts receipts into `receipts/_matched/`, `receipts/_review/`, or `receipts/_unmatched/`
6. Generates an Excel report and saves docs to `<year>/<month>/docs/`

## Requirements

- macOS Apple Silicon (arm64)
- Receipt files in a folder you own (PDF, JPG, PNG)
- Bank statement in PDF format
- Google Cloud account with Vertex AI enabled (required for receipt extraction)

## Install

Obtain the unsigned arm64 DMG (built manually — see [Building a DMG](#building-a-dmg) below). Mount, drag **Concilia.app** to **Applications**, then right-click → **Open** the first time (Gatekeeper bypass — no Apple Developer signing).

On first launch, a 4-step wizard collects:

1. Receipts folder
2. Service account JSON key
3. Optional Gemini project / location / model

Settings can be edited later via the gear icon.

## Setting up Google Gemini (Vertex AI)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project (or use an existing one)
2. Enable the **Vertex AI API** in APIs & Services
3. Go to **IAM & Admin > Service Accounts** and create a service account
4. Grant it the **Vertex AI User** role (`roles/aiplatform.user`)
5. Create a JSON key for the service account and download it
6. In the wizard or Settings, point Concilia at the JSON file

> **Note:** Vertex AI is pay-per-use. Gemini 2.5 Flash costs ~$0.10/1M input tokens. 200 receipts/month costs ~$0.04. Your data is **never used for model training** under Vertex AI terms. See [Vertex AI pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing).

## Usage

1. Drop receipts into `<receiptsRoot>/YYYY/MM/receipts/` (PDF, JPG, PNG)
2. Open Concilia
3. Select **Year** and **Month**
4. Upload one or more bank statement PDFs, selecting the bank for each
5. Click **Run Reconciliation** and watch live progress
6. Open the **Review** screen to inspect matches:
   - 👁 Preview a receipt
   - 🔄 Rescan a receipt with Gemini (retry extraction if amount/vendor was missed)
   - ✓ Accept / ✗ Reject candidates, manually assign receipts to unmatched transactions
7. Click **Apply Changes** to move files into 3-way folders and regenerate the Excel report
8. Download the report (filename: `YYYY-MM.xlsx`)

## Folder layout after processing

```text
<receiptsRoot>/2024/12/
├── receipts/
│   ├── _matched/      ← Matched receipts (send to accountant)
│   ├── _review/       ← Ambiguous matches (needs manual review)
│   ├── _unmatched/    ← Unmatched receipts
│   └── (any new receipts dropped here for the next run)
└── docs/              ← Reports and data
    ├── report.xlsx
    ├── transactions.json
    ├── receipts.json
    └── match-result.json
```

## Architecture

```text
┌─────────────────────────────────────────┐
│  Electron main (electron/main.js)       │
│  • forks Express on PORT=0              │
│  • IPC for settings + file pickers      │
└──────────────┬──────────────────────────┘
               │ http://127.0.0.1:<port>
┌──────────────┴──────────────────────────┐
│  Express server (server/)               │
│  • SSE progress stream                  │
│  • spawns workers via NODE_BIN          │
└──────────────┬──────────────────────────┘
               │
       ┌───────┼─────────┐
       ▼       ▼         ▼
   parsers/  worker/  Gemini API
```

- **Electron desktop app** for macOS arm64. Pure-JS PDF text + render (pdfjs-dist + @napi-rs/canvas) — no native binaries bundled.
- **Express server** in `server/` — orchestration, SSE, file upload, report download. No auth (single-user local).
- **React client** in `client/` (Vite + Tailwind + daisyUI), built into `server/public/`.
- **Worker scripts** in `worker/` — standalone CLI tools spawned as Electron-Node child processes.
- **Bank parsers** in `parsers/` — deterministic via `pdfjs-dist`.
- **Receipt extraction** via Google Gemini (Vertex AI), service account JWT auth.
- **Updates**: no in-app updater. DMGs built and distributed manually.

## Development

```bash
git clone https://github.com/s3rgiosan/concilia.git
cd concilia
npm run install:all                   # root + server + worker + parsers + setup-css
npm run build:assets                  # build React + setup-css
npm run dev                           # launch Electron pointing at the local checkout
```

Optional: `brew install imagemagick` only if you need to regenerate `build/icon.icns` via `npm run generate:icon`.

Run worker tests:

```bash
npm test
```

### Building a DMG

Run on a local Apple Silicon mac:

```bash
npm run dist                          # build:assets + electron-builder → dist-electron/Concilia-<version>-arm64.dmg
```

Or one-shot from a clean checkout:

```bash
npm run build                         # install:all:prod + dist
```

## Project structure

```text
concilia/
├── .github/workflows/ci.yml   # CI: tests + client build on push/PR (Linux).
├── electron/                  # Electron main, preload, config, setup wizard
│   ├── main.js                # App lifecycle, server fork, IPC handlers
│   ├── preload.js             # contextBridge: window.concilia.*
│   ├── config.js              # electron-store wrapper
│   ├── config-schema.js       # Single source of truth: fields, defaults, SERVER_ENV_KEYS
│   ├── setup.html             # First-launch wizard (vanilla HTML + setup.css)
│   └── setup-css/             # Tailwind+daisyUI build for setup.html
├── client/                    # React + Vite + Tailwind + daisyUI
│   └── src/
│       ├── App.tsx
│       ├── types.ts
│       ├── electron-bridge.d.ts # Window.concilia type definition
│       ├── i18n/              # i18next + locales/{en,pt}.json
│       └── components/        # ReconcileForm, ProgressCard, ResultsCard, ReviewScreen, RulesPanel, SettingsModal, ui/{Toast,Drawer,SidePanel}
├── server/                    # Express API
│   ├── index.mjs              # Routes
│   ├── reconcile.mjs          # Orchestration
│   └── utils.mjs
├── parsers/                   # Bank statement parsers (deterministic)
│   ├── parse.mjs              # CLI dispatch
│   ├── cgd.mjs                # CGD parser
│   └── utils.mjs
├── worker/                    # Standalone worker scripts
│   ├── lib/                   # schema, gemini, pdf-text, pdf-render, bank-fees, matcher, excel-writer
│   └── bin/                   # parse-statement, receipt-meta, extract-receipts, match, export-xlsx
├── build/                     # electron-builder resources (icon.icns, entitlements.mac.plist)
├── scripts/
│   └── generate-icon.sh       # Generate icon.icns from a 1024×1024 PNG
└── tests/worker/              # node:test suite
```

## Excel output

Two sheets:

**Reconciliation** — one row per transaction:

| date | description | amount | status | receipt_file(s) | notes | receipt_amount | receipt_confidence | receipt_currency |
|------|-------------|--------|--------|-----------------|-------|----------------|--------------------|------------------|
| 2024-12-15 | COMPRA SHOPCO | -45.99 | MATCHED | receipt.pdf | name_amount_match | 45.99 | high | EUR |
| 2024-12-16 | RESTAURANTE X | -23.50 | UNMATCHED | | | | | |
| 2024-12-17 | COMPRA Y | -50.00 | REVIEW | a.pdf; b.pdf | 2 receipts match amount | 50.00; 50.00 | high; high | EUR; EUR |
| 2024-12-18 | COMISSÃO | -2.50 | MATCHED | | bank_fee | | | |

Status column is color-coded: green (MATCHED), amber (REVIEW), red (UNMATCHED).

**Unmatched Receipts** — one row per receipt not bound to any transaction, with TOTAL row:

| file | amount | confidence | currency | vendor | date |
|------|--------|------------|----------|--------|------|
| ... | ... | ... | ... | ... | ... |
| **TOTAL** | **123.45** | | | | |

## Matching

Five-pass matching:

**Pass 0 — user-defined rules:** Match rules at `~/Library/Application Support/Concilia/match-rules.json` (vendor substring → tx description substring) bind directly. Notes: `rule_match (vendor)`.

**Pass 1 — name + amount (EUR, ±€0.05):**
- Receipt filename or vendor name matches transaction description AND amount within ±€0.05
- **Bank fee pattern** → `MATCHED` (auto, no receipt needed)
- Date-window tiebreaker (`DATE_WINDOW_DAYS`) for ambiguous candidates

**Pass 2 — amount only (EUR, ±€0.05):**
- EUR receipts matched by amount only
- Name overlap used to disambiguate multiple candidates

**Pass 3 — foreign currency (±10%):**
- Non-EUR receipts (USD, GBP, etc.) matched within ±10% of transaction amount
- Always `REVIEW` (human verifies FX conversion)

**Pass 4 — filename only:**
- Remaining transactions matched by vendor name in receipt filename
- e.g., transaction "CLOUDCO" matches `CloudCo Invoice 2025 Oct.pdf`
- Always `REVIEW` (human verifies)
- **No matches** → `UNMATCHED`

## Settings

Stored at `~/Library/Application Support/Concilia/config.json` (chmod 600). Editable via the gear icon in the navbar:

- **Language** — `en` or `pt`
- **Receipts folder** — root path containing `<year>/<month>/receipts/` subfolders
- **Gemini service account key** — path to JSON key file
- **Gemini project** (optional, auto-detected from key file)
- **Location** (default `europe-west1`)
- **Model** (default `gemini-2.5-flash`)

> The config file stores a path to the SA key, not the key contents. Treat the file as sensitive.

## Pause / resume

In-progress Accept/Reject/Assign decisions in the Review screen are auto-saved to `<period>/docs/review-draft.json` with a 500 ms debounce. Close the app mid-review and reopen — your unsaved decisions are restored. Click **Apply Changes** to commit them and clear the draft.

## Logs

`~/Library/Logs/Concilia/server.log` (rotates at 5 MB).

## License

MIT License — see [LICENSE](LICENSE)

## Contributing

Issues and PRs welcome.
