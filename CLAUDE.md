# Concilia

Bank statement reconciliation. Deterministic parsers extract transactions from bank statement PDFs; Google Gemini extracts amounts, currency, and vendor from receipts. Matches transactions against receipts by amount, sorts files into 3-way folders, and produces an Excel report.

## Architecture

- **Electron desktop app** for macOS Apple Silicon. `electron/main.js` forks the Express server on a random localhost port and loads it in a BrowserWindow. Settings (receipts root, Gemini SA key, project/location/model) stored via `electron-store` in `~/Library/Application Support/Concilia/config.json`.
- **Express server** in `server/` — thin orchestration layer (SSE progress, file upload, report download). No auth (single-user local app). Listens on `127.0.0.1` only. Reads config from env vars (`RECEIPTS_PATH`, `WORKER_DIR`, `AI_GEMINI_*`) which Electron main sets before forking.
- **React client** in `client/` — web UI built with Vite + Tailwind + daisyUI + Lucide. Built into `server/public/`, served by Express. `SettingsModal` uses `window.concilia.*` (preload contextBridge typed in `client/src/electron-bridge.d.ts`) to talk to Electron main.
- **Worker scripts** in `worker/` — standalone CLI tools for all business logic. Spawned by Express via `$NODE_BIN $WORKER_DIR/<script>.mjs` (NODE_BIN = Electron's bundled Node, with `ELECTRON_RUN_AS_NODE=1`).
- **PDF tooling — poppler everywhere**: every PDF operation in the app shells out to bundled poppler binaries.
  - `pdftotext -layout` for bank statement parsing (`parsers/cgd.mjs` via `parsers/utils.mjs::extractTextWithPoppler`) AND for receipt text extraction (`worker/lib/pdf-text.mjs` via `worker/lib/poppler.mjs::pdftotextLayout`).
  - `pdftoppm -png -r 300` for the Gemini vision-fallback receipt rendering (`worker/lib/pdf-render.mjs` via `worker/lib/poppler.mjs::pdftoppmFirstPage`).
  - Both binaries are resolved via `process.env.PDFTOTEXT_BIN` / `process.env.PDFTOPPM_BIN` (set by Electron main from the bundled `Resources/poppler/bin/` path); they fall back to `pdftotext` / `pdftoppm` on `PATH` for dev installs.
  - Why: CGD statements use Type 3 fonts that pdfjs returns as `-` placeholders. Standardising on poppler removed the previous pdfjs + `@napi-rs/canvas` stack, dropping ~10 MB of JS deps and unifying behaviour at the cost of a single GPLv2 system-tool dependency.
- **Bundling poppler**: `scripts/bundle-poppler.sh` copies `pdftotext` + `pdftoppm` from Homebrew's poppler install, recursively walks their dylib chain, copies every non-system dylib into `build/poppler/lib/`, rewrites every load command to `@executable_path/../lib/<name>`, and re-signs (ad-hoc). Bundle is ~11 MB. The script runs automatically in the `dist` npm script; CI and local builds need `brew install poppler` first.
- **Receipt extraction**: Google Gemini via Vertex AI (`worker/lib/gemini.mjs`) — service account auth, text PDFs sent as text, scanned PDFs/images sent as base64 images (300 DPI). PDF text + render are thin wrappers over the bundled poppler binaries: `worker/lib/pdf-text.mjs` → `pdftotext -layout`, `worker/lib/pdf-render.mjs` → `pdftoppm -png -r 300`. Concurrency 4 in `extract-receipts.mjs`.
- **Matching**: Five-pass matching (Pass 0 = user-defined rules; Pass 1 = name+amount EUR; Pass 2 = amount-only EUR; Pass 3 = FX; Pass 4 = filename) with date-window tiebreaker, exact cents required for EUR↔EUR (no tolerance), ±10% tolerance for FX, 3-way sorting (MATCHED/REVIEW/UNMATCHED).
- **Report**: Two-sheet Excel via `write-excel-file` — `Reconciliation` (transactions, color-coded status) + `Unmatched Receipts` (with TOTAL row). exceljs is a devDep used by tests only.
- **Updates**: no in-app update mechanism.

## File Structure

```
client/                    # React + Vite + Tailwind web UI
  src/
    App.tsx                # Single-page app: form → progress → results
    components/
      ReconcileForm.tsx    # Year/month selectors, multi-file upload, bank selection
      ProgressCard.tsx     # SSE-driven step indicators with progress bar
      ResultsCard.tsx      # Match summary + download link
  vite.config.ts           # outDir: ../server/public
  tailwind.config.js
server/                    # Express API
  index.mjs                # Routes: POST /api/reconcile (SSE), GET /report/:year/:month
  reconcile.mjs            # Orchestration: calls worker CLIs in sequence
parsers/                   # Bank statement parsers (deterministic, no AI)
  package.json             # no runtime deps (poppler binaries bundled in build/poppler/)
  parse.mjs                # CLI entry: node parse.mjs <bank> <pdf-path> → JSON stdout
  cgd.mjs                  # CGD (Caixa Geral de Depósitos) parser
  utils.mjs                # Shared: extractTextFromPDF, parseEuropeanDecimal
worker/                    # Standalone worker scripts (all business logic)
  package.json             # ESM config; runtime dep: write-excel-file. Dev: exceljs (tests only)
  lib/
    schema.mjs             # ddmmyyyyToISO, euroToCents, makeTransactionId, normalizeTransaction
    gemini.mjs             # GeminiProvider (Vertex AI), RECEIPT_PROMPT, parseJsonFromText, createSignedJwt
    pdf-text.mjs           # extractPdfText: thin wrapper over pdftotext -layout (poppler)
    pdf-render.mjs         # renderPdfPageToPng: thin wrapper over pdftoppm -png -r 300 (poppler)
    poppler.mjs            # pdftotextLayout / pdftoppmFirstPage helpers; resolves PDFTOTEXT_BIN / PDFTOPPM_BIN
    bank-fees.mjs          # noReceiptPatterns, isBankFee
    matcher.mjs            # matchTransactions: five-pass matching (Pass 0 rules + 4 algorithmic passes)
    excel-writer.mjs       # writeExcelReport: formatted .xlsx with color-coded status
  bin/
    parse-statement.mjs    # CLI: wraps parsers/parse.mjs, normalizes to canonical schema
    receipt-meta.mjs       # CLI: extract receipt metadata via Gemini AI
    extract-receipts.mjs   # CLI: batch extract all receipts from a file list
    match.mjs              # CLI: match transactions.json + receipts.json → match-result.json
    export-xlsx.mjs        # CLI: match-result.json → Excel report
electron/                  # Electron desktop wrapper
  main.js                  # App lifecycle, forks Express on PORT=0, IPC handlers
  preload.js               # contextBridge: window.concilia.{getConfig,setConfig,pickFolder,pickFile,checkUpdate,onUpdateAvailable}
  config.js                # electron-store wrapper for receiptsRoot/saKeyPath/gemini*
  setup.html               # Fallback page when receiptsRoot not configured
build/                     # electron-builder resources
  entitlements.mac.plist   # Ad-hoc signing entitlements (allow JIT, disable lib validation)
  icon.icns                # App icon (placeholder; user supplies)
.github/workflows/ci.yml   # CI: tests + client build on push/PR (Linux only).
package.json               # Electron entry; electron-builder config; install/test scripts
tests/                     # node:test suite
  worker/
    schema.test.js         # ddmmyyyyToISO, euroToCents, makeTransactionId, normalizeTransaction
    cgd.test.js            # parseEuropeanDecimal, CGD parser line matching algorithm
    parse-statement.test.js # CLI argument validation
    gemini.test.js         # parseJsonFromText, GeminiProvider with mocked fetch
    receipt-meta.test.js   # CLI argument validation
    extract-receipts.test.js # CLI argument validation + empty list handling
    bank-fees.test.js      # isBankFee Portuguese/English patterns
    matcher.test.js        # matchTransactions: 3-way sorting, tolerance, receipt consumption
    match.test.js          # CLI end-to-end matching
    export-xlsx.test.js    # CLI argument validation + XLSX generation
    excel-writer.test.js   # Cell values, status colors, unmatched receipts, bold headers
```

## Canonical Schema

All internal data uses a canonical schema:

```js
// Transaction (output of parse-statement.mjs)
{
  id: "tx-001-2025-01-15--4599",  // deterministic: index + date + amount
  date: "2025-01-15",              // ISO 8601
  description: "COMPRA LOJA",
  amount_cents: -4599,             // signed integer cents (negative = debit)
  abs_cents: 4599,                 // absolute value for matching
  status: "UNMATCHED"              // initial status
}

// Receipt metadata (output of receipt-meta.mjs)
{
  file: "<RECEIPTS_PATH>/2025/01/receipts/receipt.pdf",
  amount_cents: 4599,              // always positive (null on extraction failure)
  confidence: "high",              // "high" or null (extraction failed)
  currency: "EUR",                 // ISO 4217 from Gemini response, or null
  vendor: "ShopCo",                // vendor/merchant name from Gemini, or null
  date: "2025-01-15",              // ISO 8601 issue date from Gemini, or null
  provider_used: "gemini"          // "gemini" or "error" (all retries failed)
}
```

## Parser System

Bank statement parsing uses deterministic JS parsers. Parsers live in `parsers/` and are bundled inside the .app under `Contents/Resources/app/parsers/` (resolved via `WORKER_DIR` set by Electron main).

### CLI Interface

```bash
node parsers/parse.mjs <bank> <pdf-path>
# stdout: [{"date":"15/01/2025","description":"...","amount":-45.99}, ...]
```

The `worker/bin/parse-statement.mjs` wrapper normalizes this to canonical schema:

```bash
node worker/bin/parse-statement.mjs <bank> <pdf-path>
# stdout: [{"id":"tx-001-...","date":"2025-01-15","description":"...","amount_cents":-4599,"abs_cents":4599,"status":"UNMATCHED"}, ...]
```

Inside the packaged .app, scripts are invoked using `process.env.NODE_BIN` (= Electron's bundled Node) with `ELECTRON_RUN_AS_NODE=1`. `WORKER_DIR` env points to `Contents/Resources/app/worker/bin/`.

### Supported Banks

| Bank | Key | Parser File |
|------|-----|-------------|
| CGD (Caixa Geral de Depósitos) | `cgd` | `parsers/cgd.mjs` |

### Adding a New Bank Parser

1. Create `parsers/<bank>.mjs` exporting `async function parse(buffer)` → returns `[{ date, description, amount }]`
2. Register it in `parsers/parse.mjs` by adding to the `parsers` object
3. Add the bank option to the `BANKS` array in `client/src/components/ReconcileForm.tsx`

### CGD Parser Algorithm

- Extract text via poppler's `pdftotext -layout` (column-aware text). Required because pdfjs cannot decode the Type 3 fonts CGD uses for the Data Mov. column.
- Match lines of the form `<spaces><DataMov> <DataValor> <description>... <amount> <balance>` (both dates ISO, amounts European decimal e.g. `1.234,56`)
- Use **Data Mov.** (the first date — when the transaction was posted) as the canonical transaction date
- Convert ISO dates (YYYY-MM-DD) to DD/MM/YYYY for the parser output schema

## Receipt Extraction

### Gemini AI Pipeline (Vertex AI)

1. `receipt-meta.mjs` prepares the payload:
   - PDF with extractable text (>10 chars): extracts text via `pdftotext -layout` (`worker/lib/pdf-text.mjs`)
   - Scanned PDF: renders page 1 to PNG at 300 DPI via `pdftoppm` (`worker/lib/pdf-render.mjs`), sends as base64
   - Image (JPG/PNG): sends as base64
2. Google Gemini (Vertex AI) extracts amount, currency, vendor name, and issue date from the receipt
3. Response parsed via `parseJsonFromText()` → `{ amount_cents, confidence, currency, vendor, date }`
4. Auth: service account JSON key → JWT → OAuth2 access token (cached for 1 hour, file-cached across child processes)
5. HTTP timeout: 120s per Gemini call (`gemini.mjs`)

Usage: `node receipt-meta.mjs <file> --sa-key PATH [--project ID] [--location REGION] [--model MODEL]`

CLI flags fall back to environment variables: `--sa-key` → `AI_GEMINI_SA_KEY`, `--project` → `AI_GEMINI_PROJECT`, `--location` → `AI_GEMINI_LOCATION`, `--model` → `AI_GEMINI_MODEL`.

Batch extraction: `node extract-receipts.mjs <file-list-path> --sa-key PATH [options]` — reads newline-delimited file paths, calls `receipt-meta.mjs` for each via a bounded-concurrency pool (4 workers), outputs JSON array. Retries up to 3 times per file (backoff 0 / 1.5s / 4s) on exception or null amount. Inner exec timeout 180s. Cache (`--cache PATH`) persists ONLY `confidence: 'high'` entries; low-confidence and null entries are re-extracted on next run (a wrong amount is worse than a few extra Gemini calls).

### Per-receipt rescan (UI)

The Review screen has a 🔄 button on every receipt row (REVIEW, UNMATCHED, MATCHED). It calls `POST /api/rescan-receipt/:year/:month` which spawns `receipt-meta.mjs` for the single file, then patches `receipts.json` + `match-result.json` in place. Concurrent rescans on the same file are blocked (server returns 409).

Environment variables (set by Electron main from electron-store config):
- `AI_GEMINI_SA_KEY` (required, path to service account JSON key file)
- `AI_GEMINI_PROJECT` (optional, auto-detected from key file)
- `AI_GEMINI_LOCATION` (optional, default: `europe-west1`)
- `AI_GEMINI_MODEL` (optional, default: `gemini-2.5-flash`)
- `RECEIPTS_PATH` (required, root receipts folder)
- `WORKER_DIR` (worker/bin path; resolved by Electron main)
- `NODE_BIN` (= `process.execPath` of Electron) + `ELECTRON_RUN_AS_NODE=1` for child spawns
- `PDFTOTEXT_BIN` / `PDFTOPPM_BIN` (optional; if set, override the binary used by parser + receipt-extraction code paths. Electron main sets these to the bundled binaries. Without them, the helpers fall back to `pdftotext` / `pdftoppm` on `PATH`.)

**Security note**: SA key path is stored plaintext in `~/Library/Application Support/Concilia/config.json` (chmod 600). The key file itself remains at the user-chosen path; only the path string is persisted. Treat the config file as sensitive.

## Server Orchestration

`server/reconcile.mjs` orchestrates a full reconciliation. Sequential steps:

1. For each uploaded PDF: spawn `parse-statement.mjs` (via `NODE_BIN`) per bank → merge all transactions (deduplicate by `tx.id`)
2. Walk `<RECEIPTS_PATH>/<year>/<month>/receipts/` recursively (excluding `_matched/`, `_review/`, `_unmatched/` subfolders) using `fs.readdirSync` → write `receipt-files.txt`
3. Spawn `extract-receipts.mjs receipt-files.txt --sa-key ...`, stream stdout to a tmp file, parse JSON → write `receipts.json`. Server reads `[extract-receipts] done: <file>` and `[extract-receipts] cache hit: <file>` lines from the child's stderr (line-buffered across pipe chunks) to drive the progress bar. Note: `[receipt-meta] done:` from the inner per-file process is *captured* (not forwarded) by `execFileAsync`, so the outer extract-receipts emits its own marker after each file.
4. Spawn `match.mjs transactions.json receipts.json` → write `match-result.json`
5. Spawn `export-xlsx.mjs match-result.json report.xlsx`

Each step emits an SSE event to the browser (`data: {...}\n\n`).

SSE event types: `parsing`, `receipts_found`, `extracting`, `matching`, `exporting`, `done`, `error`.

File moves to `receipts/_matched/`, `receipts/_review/`, `receipts/_unmatched/` happen later, when the user clicks **Finalize** on the Review screen — handled by `POST /api/review/:year/:month`. Finalize is gated behind a confirmation modal (irreversible).

### API

- `GET /api/status/:year/:month` → `{ exists, applied }` for resume/badge UX
- `GET /api/busy` → `{ busy }` (any reconcile/rescan in flight) — used by Electron main to block server-restart on settings save
- `GET /api/rules` / `PUT /api/rules` — match rules array (Pass 0)
- `POST /api/reconcile` — multipart: `statements[]` (PDFs), `banks[]` (strings), `year`, `month`, optional `clearCache=true` → SSE stream. Per-period in-flight lock (returns 409 on concurrent invocation).
- `GET /api/review/:year/:month` → review data (transactions + unmatched receipts) or 404 if no reconciliation yet
- `POST /api/review/:year/:month` → **Finalize**: apply manual corrections, move files into `receipts/_matched|_review|_unmatched/`, regenerate the report, delete draft. Same lock as reconcile. Gated client-side by a confirmation modal.
- `POST /api/scan-receipts/:year/:month` → SSE stream. Re-walks receipts folder, extracts new files (cache-aware), drops entries for files no longer present, re-runs matcher with current rules, reconciles `review-draft.json` (drops decisions referencing removed receipts; preserves rest), emits `done` event with `droppedDecisions: [{ txId, description, removedReceiptFiles }]`. Same `reconcileLocks` as reconcile/finalize.
- `GET /api/draft/:year/:month` / `PUT` / `DELETE` — pending in-progress review changes (Accept/Reject/Assign decisions before Finalize); auto-saved by client with 500ms debounce, also explicitly via Save button, cleared on Finalize
- `POST /api/rescan-receipt/:year/:month` — body `{ file }` → re-run Gemini extraction on a single receipt; updates `receipts.json` + `match-result.json`. Per-file lock (409 on duplicate). symlink-resolved sandbox check via `realpathSync`.
- `GET /api/receipt/:year/:month/*` → stream a receipt file (only paths under `receipts/`, symlink-resolved)
- `GET /report/:year/:month/report.xlsx?lang=en|pt` → regenerates the Excel report on every download. Source of truth is `match-result.json` MERGED with `review-draft.json` if a draft exists (so the .xlsx reflects pending Accept/Reject/Assign decisions before Finalize). After Finalize, draft is gone and behavior collapses to plain match-result. Default lang `en`. Cache headers `no-store`. Content-Disposition: `${year}-${month}.xlsx`.

## Matching

### Five-Pass Matching with 3-Way Sorting

**Pass 0 (rules):**
0. User-defined rules from `~/Library/Application Support/Concilia/match-rules.json` — each rule maps a receipt vendor substring to a transaction description substring. Matches → `MATCHED` (notes: `rule_match (vendor)`).

**Pass 1 (name + amount, EUR):**
1. **Bank fee** — description matches `noReceiptPatterns` → `MATCHED` (notes: `bank_fee`)
2. **Name + amount** — EUR receipt filename OR vendor name matches transaction description AND amount equals tx amount exactly
   - 1 candidate → `MATCHED` (notes: `name_amount_match` or `name_amount_date_match` when receipt date is within `DATE_WINDOW_DAYS`)
   - \>1 candidates → date-window tiebreaker; remaining ambiguity → `REVIEW`

**Pass 2 (amount, EUR):**
3. **Amount match** — EUR receipts exact cents (no name requirement):
   - 1 candidate → `MATCHED`
   - \>1 candidates → prefer name overlap (filename + vendor), else `REVIEW`

**Pass 3 (FX):**
4. **FX match** — non-EUR receipts within ±10% of transaction amount:
   - Candidates found → `REVIEW` (human verifies FX conversion)
   - Name overlap used to disambiguate

**Pass 4 (filename):**
5. **Filename match** — receipt filename contains words from transaction description (min 4 chars, case-insensitive, stop words excluded):
   - Candidates found → `REVIEW` (human verifies)
   - 0 candidates → `UNMATCHED`

Receipts are consumed once matched and cannot be reused. REVIEW receipts (including FX and filename) are NOT consumed.

### Match Result Schema

`matchTransactions()` returns:

```js
{
  transactions: [
    {
      // ...original transaction fields (id, date, description, amount_cents, abs_cents)
      status: "MATCHED",            // "MATCHED" | "REVIEW" | "UNMATCHED"
      receipt_files: ["/path/to/receipt.pdf"],  // matched receipt file paths
      receipt_meta: [{ file, amount_cents, confidence, currency, vendor, provider_used }],
      notes: "amount_match"
      // Possible values:
      //   "bank_fee", "name_amount_match", "name_amount_date_match",
      //   "amount_match", "fx_match (CUR)", "filename_match",
      //   "rule_match (vendor)", "manual_match",
      //   "N receipts match name+amount", "N receipts match amount",
      //   "N fx receipts within X%", "N receipts match by filename",
      //   "" (unmatched)
    }
  ],
  receiptsByStatus: {
    matched: ["/path/to/matched.pdf"],
    review: ["/path/to/ambiguous.pdf"],
    unmatched: ["/path/to/unmatched.pdf"]
  },
  unmatchedReceipts: [{ file, amount_cents, confidence, currency, vendor, provider_used }]
}
```

### Bank Fee Patterns

Defined in `worker/lib/bank-fees.mjs`. Covers Portuguese (comissão, juros, taxa, manut. conta, anuidade, imposto de selo, despesas de conta, seguro, multa, provisão) and English (fee, commission, interest, annual charge, account maintenance, stamp duty, overdraft, wire transfer, atm). All case-insensitive; English patterns use `\b` word boundaries.

## Testing

```bash
npm test                                    # Run all worker tests
node --test tests/worker/*.test.js          # Equivalent
node --test tests/worker/matcher.test.js    # Single file
```

Uses Node.js built-in `node:test` and `node:assert` (Node >= 18). Zero npm test dependencies.

Tests use dynamic `import()` to load ESM worker modules from CommonJS test files.

`tests/worker/excel-writer.test.js` requires `exceljs` (worker devDep). After `npm run install:all:prod` (which strips devDeps), reinstall them before testing: `cd worker && npm install --include=dev`.

### Adding a Test

1. Create `tests/worker/<name>.test.js`
2. Use dynamic import: `const mod = await import('../../worker/lib/<module>.mjs')`
3. Run: `npm test`

## CI/CD

GitHub Actions pipeline (`.github/workflows/ci.yml`) runs only the **CI job** on push/PR: installs worker dependencies, runs all worker tests, installs client dependencies, builds client. Linux runner.

## npm Scripts

| Command | Description |
|---------|-------------|
| `npm test` | Run all worker tests |
| `npm run install:all` | Install root + server + worker + parsers + setup-css deps (incl. devDeps) |
| `npm run install:all:prod` | Same but skips devDeps in server/worker/parsers |
| `npm run bundle:poppler` | Run `scripts/bundle-poppler.sh` to copy + relocate Homebrew's `pdftotext` + `pdftoppm` into `build/poppler/` for the next `electron-builder` run |
| `npm run build:client` | Build React client into `server/public/` |
| `npm run build:setup-css` | Build standalone Tailwind+daisyUI CSS for `electron/setup.html` |
| `npm run build:assets` | `build:client` + `build:setup-css` |
| `npm run dev` | Launch Electron pointing at the local checkout |
| `npm run dist` | `build:assets` + electron-builder → unsigned arm64 DMG in `dist-electron/` |
| `npm run generate:icon` | `scripts/generate-icon.sh <path-to-1024x1024.png>` → `build/icon.icns` |
| `npm run build` | One-shot: `install:all:prod` + `dist` |

## Development

### Worker Scripts

All business logic lives in `worker/lib/` (libraries) and `worker/bin/` (CLI entry points). Worker scripts are standalone ESM modules that can be tested and run independently.

### Client Development

```bash
cd client && npm install
npm run dev   # Vite dev server on :5173 with proxy to Electron-hosted Express
```

Electron dev (uses values stored by Settings UI; falls back to setup screen if `receiptsRoot` is unset):
```bash
npm run install:all
npm run build:client
npm run dev
```

The Express server is **only** runnable from inside Electron — `NODE_BIN` (Electron's `process.execPath`) and `RECEIPTS_PATH` are required at startup, set by `electron/main.js` before forking the server.

### Adding Bank Fee Patterns

Add regex to the `noReceiptPatterns` array in `worker/lib/bank-fees.mjs`. Use `/i` flag for case-insensitive matching. Use `\b` word boundaries for English patterns to avoid partial matches (e.g., `\bfee\b` matches "FEE" but not "COFFEE").

## Conventions

- **Date format**: ISO 8601 (YYYY-MM-DD) internally; DD/MM/YYYY only in parser output (converted by schema.mjs)
- **Amounts**: Signed integer cents (`amount_cents`). Negative = debit/purchase, positive = credit. Receipts always stored as positive.
- **Tolerance**: exact cents for EUR↔EUR amount matching (no slop); ±10% for FX (non-EUR receipts)
- **Worker modules**: ESM (import/export), `.mjs` extension
- **Runtime deps**: write-excel-file (worker); express/helmet/multer (server); zero JS deps in parsers; electron + electron-store + semver (root). All PDF I/O goes through bundled poppler binaries (`build/poppler/`). exceljs is devDep only (tests).
- **Timezone**: Europe/Lisbon (configurable via TZ env var)
- **Receipts location**: input receipts live in `<year>/<month>/receipts/`. 3-way sorting subfolders (`_matched/`, `_review/`, `_unmatched/`) are nested inside `receipts/`
- **Settings**: stored at `~/Library/Application Support/Concilia/config.json` (electron-store, chmod 600)
- **Match rules**: stored at `~/Library/Application Support/Concilia/match-rules.json` (server reads `process.env.RULES_PATH` set by Electron main)
- **Pending review draft**: per-period `<RECEIPTS_PATH>/<year>/<month>/docs/review-draft.json` — Accept/Reject/Assign decisions before Finalize. Auto-saved by client (500ms debounce); explicit Save button forces immediate flush. Reconciled by Scan (drops decisions referencing removed receipts). Deleted when Finalize succeeds.
- **Logs**: `~/Library/Logs/Concilia/server.log` (rotates at 5 MB)

## Known Limitations

- Gemini AI extraction quality depends on receipt clarity and format
- Single-threaded matching: transaction processing order affects which receipt gets matched first
- No persistence between runs — each execution starts fresh
- Parser accuracy depends on consistent PDF formatting from the bank
- Bank description abbreviations (e.g., "SHOPCO MKT") may not match vendor names extracted by Gemini
