# Architecture

This document describes the runtime structure, data flow, and design decisions of Concilia.

## Process model

```text
┌──────────────────────────────────────────────────┐
│  Electron main (electron/main.js)                │
│  • App lifecycle, BrowserWindow, IPC handlers    │
│  • electron-store config (~/Library/.../*.json)  │
│  • forks Express server with PORT=0 → log file   │
└─────────────────┬────────────────────────────────┘
                  │ http://127.0.0.1:<random-port>
┌─────────────────┴────────────────────────────────┐
│  Renderer (React app in BrowserWindow)           │
│  • Vite-built into server/public/                │
│  • SSE client for progress, fetch for everything │
│  • preload.js exposes window.concilia.* (IPC)    │
└──────────────────────────────────────────────────┘

                  ┌─────────────────────────────────┐
                  │  Express server (server/)       │
                  │  • Listens on 127.0.0.1 only    │
                  │  • Serves React app + REST API  │
                  │  • SSE for reconcile progress   │
                  │  • Spawns worker scripts        │
                  └─────────────────┬───────────────┘
                                    │
                  ┌─────────────────┴───────────────┐
                  │  Worker scripts (worker/bin)    │
                  │  • Spawned with NODE_BIN +      │
                  │    ELECTRON_RUN_AS_NODE=1       │
                  │  • One process per task         │
                  └─────────────────────────────────┘
```

### Why this layout

- **Electron-as-Node for workers**: There is no separate Node binary in the bundled `.app`. Electron is invoked with `ELECTRON_RUN_AS_NODE=1` (env var `NODE_BIN = process.execPath` of Electron) so worker scripts run in plain V8/Node mode. The server fails fast if `NODE_BIN` is unset — it is only runnable from inside Electron.
- **Server-as-fork**: The Express server is a `child_process.fork()` of Electron-as-Node. Stdout/stderr go to a rotating log file (`~/Library/Logs/Concilia/server.log`).
- **Random port**: The server binds `PORT=0` and reports the chosen port back to Electron main via IPC. The BrowserWindow then loads `http://127.0.0.1:<port>`.
- **127.0.0.1 only**: No LAN exposure, no auth needed, single-user desktop app.

## Filesystem layout

### Source tree

```text
concilia/
├── electron/              # Electron main + preload (CommonJS)
│   ├── main.js            # App lifecycle, IPC, server fork, settings
│   ├── preload.js         # contextBridge → window.concilia.*
│   ├── config.js          # electron-store wrapper
│   ├── config-schema.js   # Single source of truth for settings
│   ├── setup.html         # First-launch wizard (vanilla)
│   └── setup-css/         # Tailwind+daisyUI build for setup wizard
├── client/                # React + Vite + Tailwind + daisyUI
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/    # ReconcileForm, ProgressCard, ResultsCard,
│   │   │                  # ReviewScreen, RulesPanel, SettingsModal, ui/*
│   │   └── i18n/          # i18next + locales/{en,pt}.json
│   └── vite.config.ts     # outDir → ../server/public
├── server/                # Express orchestration (ESM)
│   ├── index.mjs          # Routes, CSP, SSE, multipart upload
│   ├── reconcile.mjs      # Pipeline: parse → extract → match → export
│   └── utils.mjs          # writeAtomic, etc.
├── parsers/               # Bank statement parsers (deterministic, no AI)
│   ├── parse.mjs          # CLI dispatch by bank key
│   ├── cgd.mjs            # CGD parser
│   └── utils.mjs          # extractTextWithPoppler (shell-out to bundled pdftotext) + parseEuropeanDecimal
├── worker/                # Standalone worker scripts (ESM)
│   ├── lib/
│   │   ├── schema.mjs         # Canonical transaction schema
│   │   ├── gemini.mjs         # Vertex AI client + JWT signer
│   │   ├── poppler.mjs        # Shared pdftotext / pdftoppm spawn helpers
│   │   ├── pdf-text.mjs       # extractPdfText: pdftotext -layout wrapper
│   │   ├── pdf-render.mjs     # renderPdfPageToPng: pdftoppm -png wrapper
│   │   ├── bank-fees.mjs      # noReceiptPatterns / isBankFee
│   │   ├── matcher.mjs        # Five-pass matching
│   │   ├── excel-writer.mjs   # writeExcelReport
│   │   └── utils.mjs          # writeAtomic, etc.
│   └── bin/
│       ├── parse-statement.mjs   # Wraps parsers/parse.mjs → canonical schema
│       ├── receipt-meta.mjs      # Single-receipt Gemini extraction
│       ├── extract-receipts.mjs  # Batch wrapper, concurrency 4, retries
│       ├── match.mjs             # Run matcher, write match-result.json
│       └── export-xlsx.mjs       # Render Excel report
├── tests/worker/          # node:test suite
└── build/                 # electron-builder resources (icon, entitlements)
```

### Runtime data layout

User settings (electron-store, chmod 600):

```text
~/Library/Application Support/Concilia/
├── config.json            # Settings (paths only — no secrets)
└── match-rules.json       # User-defined Pass 0 rules
```

Per-period reconciliation state:

```text
<receiptsRoot>/<year>/<month>/
├── receipts/                        # Input + output files
│   ├── <receipt files>              # User-provided
│   ├── _matched/                    # Created on Finalize
│   ├── _review/                     # Created on Finalize
│   └── _unmatched/                  # Created on Finalize
└── docs/
    ├── transactions.json            # Parsed bank transactions
    ├── receipt-files.txt            # Newline-delimited file list
    ├── receipts.json                # Gemini extractions (cache)
    ├── match-result.json            # Matcher output
    ├── review-draft.json            # In-progress review decisions (auto-saved + explicit Save)
    └── report.xlsx                  # Excel output
```

Logs:

```text
~/Library/Logs/Concilia/
├── server.log               # Fresh on app start, rotated at 5 MB
└── server.log.1             # Previous rotation
```

## Reconciliation pipeline

`POST /api/reconcile` triggers `server/reconcile.mjs`. Per-period in-flight lock returns 409 on concurrent invocation. Steps emit SSE events to the browser:

```text
1. parsing            ← For each uploaded PDF: spawn parse-statement.mjs per bank,
                        merge transactions (dedupe by tx.id)
2. receipts_found     ← Walk <year>/<month>/receipts/ recursively (excluding
                        _matched/_review/_unmatched), write receipt-files.txt
3. extracting (0..N)  ← Spawn extract-receipts.mjs receipt-files.txt
                        Bounded-concurrency pool (4 workers); each spawn calls
                        receipt-meta.mjs per file. Cache hits skip Gemini.
                        Per-file retries: backoff 0 / 1.5s / 4s, 3 attempts.
4. matching           ← Spawn match.mjs transactions.json receipts.json [rules]
                        Five passes (see Matching section).
5. exporting          ← Spawn export-xlsx.mjs match-result.json report.xlsx
6. done               ← Summary + report URL
```

SSE event types: `parsing`, `receipts_found`, `extracting`, `matching`, `exporting`, `done`, `error`.

File moves into `receipts/_matched|_review|_unmatched/` happen **later**, when the user clicks **Finalize** on the Review screen (`POST /api/review/:year/:month`). The Finalize button is gated by a client-side confirmation modal (irreversible action). Before Finalize, the user can iterate via **Save** (explicit draft flush), **Scan** (re-walk receipts folder + re-extract + re-match while preserving draft), and **Download Report** (regenerates .xlsx from match-result merged with the current draft).

## Receipt extraction

`worker/bin/receipt-meta.mjs` prepares a payload per file:

| Input | Path | Tooling |
|---|---|---|
| PDF with extractable text | text payload | `worker/lib/pdf-text.mjs` → `pdftotext -layout` (poppler) |
| Scanned PDF (no text or garbage encoding) | base64 PNG (300 DPI) | `worker/lib/pdf-render.mjs` → `pdftoppm -png -r 300` (poppler) |
| Image (JPG/PNG) | base64 directly | `node:fs` |

If text extraction yields > 10 chars and passes `isLikelyReadableText` (rejects broken-font output like `ddddd dd`), it's sent to Gemini as text. Otherwise, the PDF is rasterized and sent as an image. If a text payload fails Gemini extraction, a vision fallback automatically retries with the rendered image.

### PDF tooling — poppler everywhere

Every PDF operation in the app shells out to bundled poppler binaries. Two binaries cover all uses:

- `pdftotext -layout` — bank-statement parsing (`parsers/cgd.mjs` via `parsers/utils.mjs::extractTextWithPoppler`) and receipt text extraction (`worker/lib/pdf-text.mjs`).
- `pdftoppm -png -r 300` — Gemini vision-fallback receipt rendering (`worker/lib/pdf-render.mjs`).

The shared spawn helpers live in `worker/lib/poppler.mjs`. Both binaries are resolved via `process.env.PDFTOTEXT_BIN` / `process.env.PDFTOPPM_BIN` (set by Electron main from the bundled `Resources/poppler/bin/` path); they fall back to `pdftotext` / `pdftoppm` on `PATH` for dev installs without a bundled poppler.

**Why poppler instead of pdfjs / `@napi-rs/canvas`?** CGD bank statements embed Type 3 fonts with custom encoding for the Data Mov. column — pdfjs returns `-` placeholders for those glyphs; poppler decodes them correctly. Once we needed poppler for that path, standardising on it for receipt extraction too removed ~10 MB of JS dependencies and unified all PDF behaviour at the cost of a single GPLv2 system tool.

**Bundling.** `scripts/bundle-poppler.sh` copies `pdftotext` + `pdftoppm` from Homebrew's poppler install, recursively walks their dylib chain, copies every non-system dylib into `build/poppler/lib/`, rewrites every load command to `@executable_path/../lib/<name>`, and re-signs ad-hoc. The bundle is ~11 MB. The script runs automatically as a step inside `npm run dist` (and therefore `npm run build`); CI and local builds need `brew install poppler` before invoking the build.

### Gemini auth

Service account → JWT (signed with the SA's RSA private key) → OAuth2 access token (cached for 1 hour, file-cached across child processes). HTTP timeout: 120 s per Gemini call.

The SA key path is stored plaintext in `~/Library/Application Support/Concilia/config.json` (chmod 600). The key file itself stays at the user-chosen path; only the path string is persisted.

## Matching

Five passes with date-window tiebreaker, **exact cents** for EUR↔EUR (no tolerance), **±10% for FX** (non-EUR receipts). Receipts consumed once matched (REVIEW receipts are NOT consumed):

| Pass | Logic | Outcome |
|---|---|---|
| 0 | User rules: vendor substring → tx description substring | MATCHED (`rule_match (vendor)`) |
| 1a | `noReceiptPatterns` (Portuguese + English) | MATCHED (`bank_fee`) |
| 1b | EUR receipt filename OR vendor matches description AND amount equals tx amount exactly | 1 candidate → MATCHED; >1 → date-window tiebreaker → REVIEW |
| 2 | EUR receipts whose amount equals tx amount exactly, no name requirement | 1 → MATCHED; >1 → name overlap; ambiguous → REVIEW |
| 3 | Non-EUR within ±10% | REVIEW (human verifies FX) |
| 4 | Filename-only match (≥4-char words, stop-words excluded); EUR receipts must still match the exact cents | REVIEW |
| — | No candidates | UNMATCHED |

Pass 3 short-circuits when the period contains no non-EUR receipts (avoids an O(N×M) scan of the amount index for the common single-currency case).

## Canonical schema

```js
// Transaction (output of parse-statement.mjs)
{
  id: "tx-001-2025-01-15--4599",   // index + date + amount, deterministic
  date: "2025-01-15",               // ISO 8601
  description: "COMPRA LOJA",
  amount_cents: -4599,              // signed integer cents
  abs_cents: 4599,                  // for matching
  status: "UNMATCHED"
}

// Receipt metadata (output of receipt-meta.mjs)
{
  file: "<RECEIPTS_PATH>/2025/01/receipts/r.pdf",
  amount_cents: 4599,               // always positive; null on extraction fail
  confidence: "high",               // "high" or null
  currency: "EUR",                  // ISO 4217 or null
  vendor: "ShopCo",                 // or null
  date: "2025-01-15",               // ISO 8601 or null
  provider_used: "gemini"           // "gemini" or "error"
}
```

## API surface

Express server, `127.0.0.1` only, no auth.

### Reconciliation
- `POST /api/reconcile` — multipart (`statements[]`, `banks[]`, `year`, `month`, optional `clearCache=true`) → SSE stream
- `GET /api/status/:year/:month` — `{ exists, applied }` for resume/badge UX
- `GET /api/busy` — `{ busy }` (used by Electron main to block server-restart on settings save)

### Review
- `GET /api/review/:year/:month` — review data (transactions + unmatched receipts)
- `POST /api/review/:year/:month` — **Finalize**: apply manual corrections, move files, regenerate the report, clear draft
- `POST /api/scan-receipts/:year/:month?lang=en|pt` — SSE stream. Re-walks receipts dir, extracts new files (cache-aware), drops entries for removed files, re-runs matcher, reconciles draft (drops decisions whose receipts vanished, keeps rest). `done` event includes `{ summary, droppedDecisions, reportUrl }`.
- `GET /api/draft/:year/:month` / `PUT` / `DELETE` — pending Accept/Reject/Assign decisions
- `POST /api/rescan-receipt/:year/:month` — body `{ file }` → re-run Gemini on a single receipt

### Rules
- `GET /api/rules` / `PUT /api/rules` — user-defined Pass 0 rules

### Files
- `GET /api/receipt/:year/:month/*` — stream a receipt (sandboxed via `realpathSync` to `receipts/`)
- `GET /report/:year/:month/report.xlsx?lang=en|pt` — regenerates the report on every request and streams it with `Cache-Control: no-store`. Source of truth is `match-result.json` **merged with `review-draft.json`** if a draft exists, so the .xlsx reflects the user's current pending decisions before Finalize. After Finalize, draft is gone and behavior collapses to plain match-result. Renaming columns or toggling language in Settings takes effect on the next download.

## IPC surface

`electron/preload.js` exposes `window.concilia.*` (`contextIsolation: true`):

- `getConfig()` / `setConfig(patch)` — read/write electron-store; restarts server when `serverEnv` keys change
- `pickFolder()` / `pickFile(filters)` — native dialogs
- `bootLanguage` — language string passed via `additionalArguments` so i18n applies before first paint (avoids English flash)

## Build

- **Local development**: `npm run install:all && npm run build:assets && npm run dev`
- **CI**: GitHub Actions runs tests + client build on Linux.

## Threat model / privacy

- All data is local. No cloud storage, no telemetry.
- Server binds `127.0.0.1` only; no LAN exposure.
- Single-user app, no auth.
- Receipt content is sent to Google Vertex AI for extraction (text or image). Per Vertex AI terms, customer data is **not used to train Google's models**.
- SA key path is stored in `config.json` (chmod 600). The key file itself stays at the user-chosen path.
- Logs (`~/Library/Logs/Concilia/server.log`) record file paths, transaction IDs, and SSE events. Match rules are logged by *count only* (rule contents are PII-ish vendor substrings).

## Conventions

- **Dates**: ISO 8601 (YYYY-MM-DD) internally; DD/MM/YYYY only inside parser boundary
- **Amounts**: signed integer cents (`amount_cents`); negative = debit/purchase, positive = credit; receipts always positive
- **Tolerance**: exact cents (EUR↔EUR matching), ±10% (FX, non-EUR receipts)
- **Modules**: ESM throughout (`.mjs` extension); Electron main is CommonJS for Electron API compatibility
- **Timezone**: Europe/Lisbon (configurable via `TZ` env var)
- **Receipts location**: input lives in `<year>/<month>/receipts/`; 3-way subfolders nested inside `receipts/`
