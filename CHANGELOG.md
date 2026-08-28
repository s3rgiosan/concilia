# Changelog

All notable changes to this project are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.1] - 2026-08-28

### Fixed

- Concurrent single-file rescans of *different* receipts in the same period (still permitted by design) each did an independent read-modify-write of the shared period JSON (`receipts.json`, `match-result.json`, `reimbursements.json`), so the later writer overwrote the earlier one's patch and a rescanned amount could silently revert. The write sections are now serialized per period through a promise-chain mutex, while the slow Gemini extraction calls stay parallel.
- `writeAtomic` left an orphan `.tmp` file behind when `renameSync` failed (permissions, out of space); it now removes the temp file before re-throwing.
- Two matcher call sites dereferenced `receipt.file` without the null guard used elsewhere; they now match the guarded sites.
- `parseEuropeanDecimal` threw on a numeric or non-string argument (`value.trim is not a function`); it now returns a number as-is and coerces other inputs safely.

### Security

- The Electron config file is now locked to `0o600` at load, not only on the first settings save. `electron-store` writes the file on construction, so it previously sat world-readable (per the user's umask) until the first `setConfig`. The file stores the path to the Gemini service account key.

## [1.3.0] - 2026-08-02

### Added

- In-app update notifier. On launch the app polls the GitHub Releases API, compares the latest tag against the running version with `semver.gt`, and shows a dismissible banner linking to the release page when a newer version exists. Notify-only by design — there is no auto-download and no auto-install, because Squirrel.Mac requires a Developer ID signature, which an ad-hoc signed build does not have. Every failure path (offline, rate-limited, non-200, malformed response) resolves silently to "no update"; the check never blocks startup. New IPC `update:check`, exposed as `window.concilia.checkUpdate()`.
- App version is now shown read-only in the Settings modal, via a new `app:version` IPC (`window.concilia.getVersion()`). Previously the version appeared nowhere in the UI.

### Changed

- macOS builds are now ad-hoc signed (`mac.identity: "-"`, was `null`, i.e. unsigned). This does **not** change Gatekeeper behaviour — first launch still requires `xattr -dr com.apple.quarantine /Applications/Concilia.app` — but it gives the bundle a stable code identity, which macOS Keychain ACLs and TCC privacy prompts key off, so folder-access permissions should stop being re-requested on every launch.
- Finalize confirmation is now a native `<dialog>` — Escape and focus trapping come from the platform, and initial focus lands on Cancel so Enter cannot confirm the irreversible action by accident.

### Fixed

- **Receipts with an unverified currency no longer auto-match.** `isEur()` treated a `null` currency (Gemini failed to determine one) as EUR, so such receipts got the strictest exact-cents auto-MATCH path instead of the most cautious one — a foreign-currency receipt could silently MATCH a same-cents EUR transaction with no REVIEW flag. `isEur()` now requires `currency === 'EUR'`; unknown-currency exact-cents matches route to `REVIEW` with notes `unknown_currency_match` and are never consumed. Pass 3 (FX) now gathers candidates via `isKnownForeignCurrency()` so unknown-currency receipts are not swept into the ±10% tolerance.
- **Portuguese bank-fee patterns no longer swallow real invoices.** `/imposto.*selo/i`, `/manut.*conta/i`, `/taxa.*manut/i` and `/despesas.*conta/i` lacked `\b` anchors, so `conta` matched inside `contabilidade` — an accounting invoice was auto-classified `bank_fee` in the first pass and permanently excluded from reconciliation. English `/\bannual.*charge\b/i` and `/\bwire.*transfer\b/i` had the same class of over-broad `.*` span.
- Pass 2's date-tiebreaker fallback reported `name_amount_date_match` ("Name, amount & date match" in the report) even when no name overlap was found. Now `amount_date_match`, with EN/PT labels.
- Report download (`GET /report/:year/:month/report.xlsx`) regenerated the .xlsx directly over the canonical path with no lock — concurrent downloads interleaved writes and a crash mid-generation left a truncated file that was then served. Now writes to a `.tmp` and renames on success, guarded by the period lock (409 while a reconcile is in flight).
- Finalize recorded the post-move receipt path even when `renameSync` failed (`EXDEV` on a network-share receipts root, permission errors), leaving `match-result.json` pointing at files that were never moved. Moves are now planned up front and rolled back on any failure, preserving the documented all-or-nothing contract.
- A reconcile that hit the 30-minute timeout left its child process running while the period lock was released, so a retry put two pipelines on the same output files. Children are now tracked, SIGTERM'd (SIGKILL after 5s), and awaited before the lock is released. Client disconnect (`req.on('close')`) routes through the same path.
- Single-file rescan and the period-level endpoints used separate lock namespaces while both read-modify-writing `match-result.json` — a rescan finishing after Finalize could overwrite it with pre-move paths. Both now cross-check and return 409. Concurrent rescans of different files in the same period are still allowed.
- Uploaded statement PDFs leaked into the OS temp dir on every early-return path in `POST /api/reconcile` (invalid period, unknown bank, missing SA key, 409). All early returns now clean up.
- The reconcile SSE stream ending without a terminal event left the UI spinning forever; the scan-receipts stream ending early reported a false "scan complete" success, so a user could Finalize on incomplete data. Both consumers now treat stream-end-without-`done` as an error, via a shared `client/src/lib/sse.ts` helper.
- Finalize could be overwritten by a debounced draft autosave landing after the server deleted the draft, silently reviving superseded decisions in the report. `finalize()` now cancels the pending timer and aborts any in-flight draft PUT.
- `ReconcileForm`'s status fetch had no race guard, so rapid month changes could show a resume banner for the wrong period.
- The reconcile `AbortController` was returned from an `onSubmit` handler where React never invoked it, so an in-flight reconcile fetch could outlive the component. Now aborted on unmount.
- Navigating away from Review via the "Start" breadcrumb discarded unflushed decisions without warning.

## [1.2.0] - 2026-05-10

### Added

- Reimbursements folder: drop receipts paid personally on the company's VAT into `<RECEIPTS_PATH>/<year>/<month>/reimbursements/` and Concilia extracts them via the existing Gemini pipeline. Not run through the matcher (no transaction to match against).
- Excel report: new `Reimbursements` sheet (PT: `Reembolsos`) — one row per file with vendor, date, amount, currency, confidence, plus a TOTAL row. Sheet appears only when reimbursements exist.
- Excel `Totals` sheet: extra row `Reimbursements (paid personally)` (PT: `Reembolsos (pagos pessoalmente)`) summing all reimbursement amounts. Appears only when reimbursements exist.
- Review screen: read-only collapsible Reimbursements section listing each file with vendor/date/amount, open-in-tab preview link, and per-file rescan button. No Accept/Reject/Assign — files stay in place on Finalize.
- `POST /api/rescan-reimbursement/:year/:month` mirroring `/api/rescan-receipt`. Sandboxed to `<period>/reimbursements/`. Patches `docs/reimbursements.json` only (no matcher state).
- `extract-receipts` cache file `docs/reimbursements.json` (same shape as `receipts.json`, only `confidence: 'high'` cached).
- `worker/bin/export-xlsx.mjs --reimbursements <path>` CLI flag — server passes it on every export call (reconcile, Finalize, report download).

### Changed

- Existing **Scan receipts** button now also scans the reimbursements folder. PT label changed from "Verificar recibos" to "Examinar recibos".
- `GET /api/review/:year/:month` response includes a `reimbursements` array (each entry enriched with `receiptUrl`).
- `GET /api/receipt/:year/:month/*` sandbox broadened to also serve files under `reimbursements/` (in addition to `receipts/`).
- `server/reconcile.mjs`: extracted shared `extractToCache()` helper from `runExtractAndMatch`; new `runReimbursements()` runs the parallel mini-pipeline.

## [1.1.0] - 2026-05-08

### Added

- Excel report restructured into five sheets in this order: `Totals`, `Validated`, `Matched`, `Review`, `Unmatched` (PT: `Totais`, `Validados`, `Associados`, `Revisão`, `Sem Associação`). The previous single-sheet `Reconciled` is renamed to `Validated`.
- Excel `Totals` sheet: two rows — `Transactions without receipt` (signed sum of MATCHED transactions tagged `No receipt`) and `Unmatched receipts` (sum of receipt amounts that didn't get matched to any transaction). Structured so additional totals can be appended later.
- Excel `Matched` / `Review` / `Unmatched` sheets: one row per receipt with file, vendor, date, amount, currency, confidence; matched/review rows also carry the parent transaction's date, description and amount. Bank-fee / no-receipt-category transactions are excluded from `Matched`.

### Changed

- Review screen: header (top action row + breadcrumb) is now sticky to the top of the viewport, and the action button row at the bottom of the Review screen is sticky to the bottom — both stay visible while the transaction list scrolls.
- Review screen toolbar (filter pills, name filter, Expand/Collapse toggle) is now hosted inside the sticky header instead of inside the card body, so filtering and expanding stay one click away while scrolling.
- Below 1024 px viewports, the toolbar wraps onto two rows: pills on row 1, name filter + Expand/Collapse on row 2.
- Renamed the internal `other` no-receipt category key to `no_receipt` (UI label "No receipt" / "Sem recibo" unchanged). Any pre-existing `notes: "other"` values from prior sessions render as the raw string in the report — no migration shim, per the project's no-back-compat rule.

## [1.0.1] - 2026-05-07

### Changed

- Review screen toolbar: name filter now expands to fill the available space, and the Expand/Collapse toggle is right-aligned at the end of the row. Both controls and the filter pills now share the same 40 px row height.
- Expand/Collapse toggle labels shortened from "Expand all" / "Collapse all" to "Expand" / "Collapse".
- Rules panel: when the renderer is not running inside Electron (e.g. via `cd client && npm run dev`), the panel now skips the `/api/rules` fetch, disables every interactive control, and shows a banner — same pattern as the Settings drawer — instead of throwing a "Failed to load rules" toast.

## [1.0.0] - 2026-05-07

Initial release.

### Highlights

- macOS Apple Silicon desktop app
- Local-only single-user app: Express server bound to `127.0.0.1`, no auth, no cloud storage of your data
- English and Portuguese UI with user locale preference (Excel report headers also localized)

### Features

- **Bank statement parsing**: deterministic per-bank parsers (no AI). Ships with CGD (Caixa Geral de Depósitos, Portugal); extensible registry pattern documented in [`.github/BANK_PARSER_GUIDE.md`](.github/BANK_PARSER_GUIDE.md).
  - CGD parser uses poppler's `pdftotext -layout` and reads **Data Mov.** (transaction posting date) — pdfjs cannot decode the Type 3 fonts CGD uses for that column. Requires `pdftotext` on PATH (or `PDFTOTEXT_BIN` env var); install with `brew install poppler` on macOS.
- **Receipt extraction** via Google Gemini (Vertex AI):
  - Service-account JWT auth, OAuth2 token cached for 1 hour and shared across child processes
  - Text PDFs sent as text; scanned PDFs and images sent as 300 DPI base64 PNGs
  - Vision fallback if text extraction yields garbage
  - Bounded-concurrency pool (4 workers), per-file retries with backoff, 180 s timeout
  - High-confidence results cached across runs to skip duplicate Gemini calls
- **Five-pass matching** with date-window tiebreaker:
  - Pass 0: user-defined rules (vendor substring → tx description substring)
  - Pass 1: name + amount, EUR exact cents (no tolerance for same-currency); bank-fee patterns auto-MATCHED
  - Pass 2: amount only, EUR exact cents, with name overlap disambiguation
  - Pass 3: foreign currency (±10 %) → REVIEW
  - Pass 4: filename match → REVIEW; no candidates → UNMATCHED
- **Review workflow** — non-destructive iteration before commit:
  - **Filter**: status pills (All / Review / Unmatched / Matched) plus a name filter that narrows by description substring; both reset on data reload.
  - **Expand all / Collapse all**: single toggle that operates on the currently visible (filtered) transactions.
  - **Income vs. expense cue**: each transaction amount renders with a directional arrow (green ↗ income, red ↘ expense) so the kind is identifiable at a glance.
  - **Save**: explicit immediate flush of pending decisions to `review-draft.json`, with toast feedback (auto-save still runs every 500 ms in the background)
  - **Scan**: re-walk the receipts folder, extract newly added files (cache-aware), drop entries for removed files, re-run the matcher. Preserves draft decisions; drops only those whose referenced receipt was removed and shows a banner naming affected transactions. Streams progress in a modal that reuses the reconcile progress UI.
  - **Download Report**: at any time. The .xlsx merges pending draft decisions on top of `match-result.json` so it reflects the current Review screen state — no need to Finalize first.
  - **Finalize**: gated behind a confirmation modal explaining the action is irreversible. Moves receipts into `_matched/`, `_review/`, `_unmatched/` subfolders, regenerates the Excel report, deletes the draft.
- **Per-transaction actions** in the Review screen: Accept / Reject / Assign / Dispute, in-line PDF preview, per-receipt rescan with Gemini. Disputing a MATCHED transaction returns its receipts to the UNMATCHED candidate pool. Amount-mismatch warning (⚠) flags any cent diff for EUR receipts and uses the ±10 % rule for non-EUR receipts.
- **Pause / resume**: in-progress review decisions auto-saved (500 ms debounce) to `review-draft.json`, restored on next launch.
- **Excel report** (`write-excel-file`): single **Reconciled** sheet with color-coded status; sheet name + column headers localized per app language.
- **Setup wizard**: first-launch flow collects receipts folder + Vertex AI service-account key + optional project/location/model. Wizard primary buttons (`Get started` / `Continue` / `Finish`) and active step numbers render in white over the primary background.
- **Settings** stored in `~/Library/Application Support/Concilia/config.json` (chmod 600).
- **Logs** in `~/Library/Logs/Concilia/server.log` (rotates at 5 MB).

### Distribution

- GitHub Actions release workflow (`.github/workflows/release.yml`) builds and publishes the unsigned arm64 DMG on tag push (plain semver, e.g. `1.0.0`) or manual dispatch.
- README installation section documents the DMG build (`npm run build`) and the Gatekeeper first-launch step.

### Tech stack

- Electron + electron-store
- React + TypeScript + Vite + react-i18next + Tailwind CSS + daisyUI + Lucide
- Node.js (Electron-as-Node) + Express
- poppler `pdftotext` (CGD parser); pdfjs-dist + `@napi-rs/canvas` (worker render path)
- Google Gemini 2.5 Flash via Vertex AI
- write-excel-file
- node:test (built-in)

### Known limitations

- Apple Silicon (arm64) only.
- Poppler (`pdftotext`) is a runtime dependency for the CGD parser and is not yet bundled in the .app — packaged installs require the user to install it (e.g. `brew install poppler`).
- Gemini extraction quality depends on receipt clarity and format.
- Single-threaded matching: transaction processing order can affect which receipt binds first when amounts are tied.
- No persistence between runs beyond per-period `<year>/<month>/docs/` JSON artifacts; each reconciliation starts fresh.
- Bank description abbreviations (e.g. `SHOPCO MKT`) may not match vendor names extracted by Gemini.
