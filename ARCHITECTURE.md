# Architecture

## Process model

```text
┌─ Concilia.app (Tauri 2) ──────────────────────────────────────────┐
│                                                                   │
│  Webview windows (React, src/)          Rust core (src-tauri/src) │
│  ┌──────────────────────────┐  invoke   ┌──────────────────────┐  │
│  │ main     index.html      │ ────────► │ commands.rs          │  │
│  │          ?view=main      │           │  → pipeline/         │  │
│  │ settings ?view=settings  │ ◄──────── │  → matcher, excel,   │  │
│  └──────────────────────────┘  events,  │    gemini, bank      │  │
│        ▲ receipt:// previews  channels  └─────────┬────────────┘  │
│        └──────────────── protocol.rs              │               │
│                                                   ▼               │
│                      poppler (Resources/poppler/bin), Keychain,   │
│                      receipts folder, Gemini over HTTPS           │
└───────────────────────────────────────────────────────────────────┘
```

- One process. The Rust core owns every file, the Gemini client and the native surfaces (menu bar, alerts, appearance, zoom, updates). The webview draws the UI and calls commands.
- `App.tsx` picks the window from `?view=`. The main window holds the month sidebar, the month screen and the review. The Settings window opens on demand (`windows.rs`).
- Long jobs (reconcile, scan, add statements) stream `RunEvent` progress over a Tauri `Channel` and can be cancelled. Settings changes reach every window as the `settings-changed` event.
- `docs/wiring.md` lists every menu item, alert, event and permission.

## Source tree

```text
src/                         React frontend
├── main/                    main window: sidebar, month screen, run progress, welcome
├── review/                  review list, details column, decisions, row menus
├── settings/                Settings window: Folder, Gemini, Rules, Reasons, General panes
├── components/              sheets, pop-up buttons, toolbar, icons
├── lib/                     tauri.ts (typed command wrappers), menus, hooks, reasons
├── i18n/locales/            en.json, pt.json
└── dev/mock.ts              browser preview backend (npm run dev outside Tauri)

src-tauri/
├── src/
│   ├── lib.rs               app setup, plugins, command registration, menu events
│   ├── commands.rs          Tauri commands: input checks, locks, then pipeline calls
│   ├── app.rs               shared state: settings, rules, reasons, key, locks, granted paths
│   ├── config.rs            config.json, rules.json, reasons.json
│   ├── pipeline/            reconcile, scan, add statements, rescan, draft, finalize,
│   │                        reopen, report, month folders
│   ├── matcher.rs           matching passes
│   ├── bank/                statement parsers (cgd.rs) and normalization
│   ├── gemini/              Agent Platform client, prompts, reply parsing
│   ├── extract.rs           receipt extraction with cache, retries, concurrency
│   ├── excel/               report layout and labels
│   ├── finalize.rs          Finalize planning and file moves
│   ├── review.rs            applying draft decisions, summaries
│   ├── poppler.rs           pdftotext / pdftoppm
│   ├── protocol.rs          receipt:// scheme for previews
│   ├── secrets.rs           Keychain (release) or file (debug) key store
│   ├── menu.rs, alert.rs, appearance.rs, zoom.rs, windows.rs, updates.rs
│   └── locks.rs             per-period locks
├── tests/                   integration tests, golden fixtures from the Node implementation
├── capabilities/            main.json, settings.json: commands each window may call
├── tauri.conf.json          app, bundle and updater config
└── tauri.macos.conf.json    macOS window, DMG target, Assets.car icon

worker/, parsers/, tests/worker/   Node reference implementation, kept to compare against
                                   (npm run test:legacy); the app does not use it
```

## Data

### Settings

`~/Library/Application Support/com.s3rgiosan.concilia/`:

- `config.json`: language, receipts folder, Gemini project, location and model, update checks.
- `rules.json`: receipt rules (`receiptVendor` + `transactionDescription`) and no-receipt rules (`transactionDescription` + `noReceipt` reason id).
- `reasons.json`: no-receipt reasons with English and Portuguese names. Without the file, the shipped reasons apply. A `rules.json` or `reasons.json` that does not parse stays on disk untouched: Settings shows a banner and refuses to save it, and reconcile, scan, finalize, reopen and report refuse to run until the file is fixed.

Debug builds use `config.dev.json`, `rules.dev.json` and `reasons.dev.json`. The service account key is in the Keychain for release builds and in `service-account.dev.json` for debug builds.

### Months

```text
<receipts folder>/<YYYY>/<MM>/
├── receipts/                 input receipts; _matched/, _review/, _unmatched/ after Finalize
├── reimbursements/           receipts paid personally; read, never matched
└── docs/
    ├── statements.json       statements added to the month
    ├── transactions.json     parsed transactions
    ├── receipts.json         extraction cache (high-confidence entries are reused while
    │                         the file keeps its size and modification time)
    ├── reimbursements.json   reimbursement extraction cache
    ├── match-result.json     matcher output (after Finalize: the final result)
    ├── review-draft.json     decisions not yet finalized, laid over match-result.json
    ├── report.xlsx           Excel report
    ├── moves.json            receipt moves of a Finalize, Reopen or reset still in progress
    └── .applied              marks the month as finalized
```

The JSON files store receipt paths relative to the month folder (`receipts/acme.pdf`), so the receipts folder can move without losing the review. In memory and in the webview, paths are absolute (`pipeline/stored.rs`).

## Jobs

- **Reconcile**: parse the statements (pdftotext, then the bank parser), find receipts, extract them (cache first), match, write the report.
- **Scan for New Receipts**: extract only new files, drop cache entries for removed files, match again, keep the draft's decisions whose receipts still exist and receipts assigned by hand.
- **Add statements**: merge new transactions with stable ids and skip rows already present, then match again keeping decisions.
- **Rescan**: read one receipt again and patch the cache and the result.
- **Finalize**: apply the draft, move every receipt into its status folder, write the final result (with each receipt's original path) and report, mark the month, delete the draft. All files move or none do.
- **Reopen**: move the sorted receipts back to their original folders and names, rebuild the cache with the new paths, keep the decisions that differ from a fresh match as the draft, remove the marker. All-or-nothing with backups.
- **Reconcile Again**: reconcile with a reset first: move sorted receipts back to their original folders and names, keep a finalized month's review decisions in the draft as Reopen does, delete the extraction cache, the match result and the finalized marker, then read every receipt again. A receipt that cannot move back stops the run before anything is deleted, and the moves already made are undone. A finalized marker that cannot be deleted stops the run the same way; a match result or cache file that cannot be deleted stops it with an error.

Finalize, Reopen and the reset write `moves.json` before the first receipt moves and delete it when they are done. If the app stops in between, the next job on the month (reconcile, scan, add statements, Finalize, Reopen, report export) moves the files back from the journal first, unless the finalized marker shows the job finished. A file that cannot move back, then or in a rollback, is named in the error.

A month runs one exclusive job at a time (`locks.rs`). Rescans of different files can run together; their writes go through one mutex per month. A draft save is refused while a job runs and on a finalized month; a job that starts during a save waits for it. The review retries a save refused by a running job, and flushes pending decisions before Reconcile Again.

## Matching

`matcher.rs`, in order, each pass seeing only transactions still UNMATCHED:

1. No-receipt rules, then bank fees: MATCHED with a reason id as `notes`.
2. Pass 0, receipt rules: vendor and description keywords, amount must fit.
3. Pass 1, name and exact amount (EUR); unknown currency is REVIEW.
4. Pass 2, exact amount (EUR), name overlap breaks ties; unknown currency is REVIEW.
5. Pass 3, foreign currency within ±10% with a shared name word: REVIEW.
6. Pass 4, shared name word: REVIEW.

Exact cents for EUR, ±10% for foreign currency, a 45-day date window for ties. Only MATCHED takes a receipt.

A transaction whose `notes` is a reason id (`bank_fee`, `salary`, `transfer`, `refund`, `no_receipt`, or `reason:<id>`) needs no receipt. A deleted reason's id still counts and shows as Other.

## Receipt extraction

- Text PDFs go to Gemini as text (`pdftotext -layout`); scanned PDFs as a page image (`pdftoppm`, 300 DPI); JPG and PNG as images.
- Four receipts at a time; three attempts each, after 0, 1.5 and 4 seconds; 180 seconds per attempt.
- Files over the size limit, or that are not a real PDF or image, are refused with a reason and stay in the receipts folder.
- Auth: the service account key signs a JWT, exchanged at `oauth2.googleapis.com` for an access token. Requests go to `aiplatform.googleapis.com` in the configured location (default `europe-west1`, model `gemini-2.5-flash`).

## Poppler

Every PDF operation uses poppler. `poppler.rs` uses `Resources/poppler/bin/` when both tools are there, else `pdftotext` and `pdftoppm` on `PATH`. `scripts/bundle-poppler.sh` copies them and their libraries from Homebrew into `build/poppler/`, rewrites the library paths and ad-hoc signs them; the release adds that folder as a bundle resource.

## Build and release

- `npm run tauri dev`: debug app with hot reload.
- `npm run tauri build`: release bundle. The macOS target is a DMG; the release adds `build/poppler` as a resource.
- CI (`.github/workflows/ci.yml`) runs typecheck, lint, the frontend build and tests, `cargo fmt --check`, clippy and `cargo test` on macOS, Ubuntu and Windows, plus the Node reference tests.
- Release (`.github/workflows/release.yml`) runs on a semver tag such as `2.0.0`. It checks that the tag matches `package.json`, `tauri.conf.json` and `Cargo.toml`, bundles poppler, builds the DMG and the signed updater archive, and uploads `latest.json` for in-app updates.

## Privacy and security

- Files stay local. Receipts go to Gemini to be read (text or image); statements never leave the machine. Update checks go to GitHub releases.
- The service account key is in the Keychain, not in a file Concilia keeps.
- Each window may call only the commands its capability file grants. The Settings window cannot run month jobs.
- Commands accept only files and folders the user chose in a dialog or dropped on a window.
- `receipt://` serves only files under a month's `receipts/` or `reimbursements/` whose real path stays inside and whose extension is allowlisted.
- The webview's content security policy allows only the app, `receipt:` and IPC.
- Logs are local, in `~/Library/Logs/com.s3rgiosan.concilia/`.

## Conventions

- **Dates**: ISO 8601 (`YYYY-MM-DD`) everywhere except parser output (`DD/MM/YYYY`).
- **Amounts**: signed integer cents; negative is a debit. Receipt amounts are positive.
- **Languages**: English and Portuguese for the UI, the report and reason names.
- **Commands**: declared in `build.rs`, registered in `lib.rs`, granted in `capabilities/*.json`; `tests/capabilities.rs` checks all three agree.
