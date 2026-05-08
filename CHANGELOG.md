# Changelog

All notable changes to this project are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
