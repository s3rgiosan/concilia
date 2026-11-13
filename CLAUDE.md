# Concilia

Bank statement reconciliation desktop app. Deterministic Rust parsers read transactions from bank statement PDFs; Google Gemini reads amount, currency, vendor and date from receipts. The matcher pairs them, Finalize sorts the receipt files into `_matched`, `_review` and `_unmatched`, and the app writes an Excel report.

Tauri 2 app: Rust backend in `src-tauri/`, React + TypeScript webview in `src/`. Released for macOS (Apple silicon); CI also runs on Linux and Windows.

Read first:

- `ARCHITECTURE.md`: process model, source tree, data files, jobs, matching, extraction, privacy.
- `docs/wiring.md`: every menu item, context menu, alert, event and permission. Update it with any change to those.
- `README.md`: features, usage, build and the Gemini setup.
- `.github/BANK_PARSER_GUIDE.md`: adding a bank.

## Commands

```bash
npm ci
npm run tauri dev                 # debug app, hot reload, poppler from PATH
npm run dev                       # browser preview with the mock backend (src/dev/mock.ts), port 1420
npm test                          # Vitest
npm run typecheck && npm run lint
cd src-tauri && cargo test        # Rust tests; poppler tests skip without poppler on PATH
cargo fmt --check && cargo clippy --all-targets -- -D warnings
npm run test:legacy               # Node reference implementation (worker/, parsers/)
npm run bundle:poppler            # copy Homebrew poppler into build/poppler/ for a release build
npm run tauri build -- --config '{"bundle":{"resources":{"../build/poppler":"poppler"}}}'
```

`npm run symbols` (run by the `pre*` scripts) exports the icons in `src/components/Icon.tsx` into `src/assets/symbols/`: SF Symbols on macOS, Lucide elsewhere. A new icon needs an entry in `SYMBOL_NAMES`, `scripts/export-symbols.swift` and `scripts/symbols.mjs`.

## Adding a command

1. `#[tauri::command]` in `src-tauri/src/commands.rs` (or `menu.rs`, `alert.rs`, …).
2. Add the name to `COMMANDS` in `src-tauri/build.rs` and to `generate_handler!` in `src-tauri/src/lib.rs`.
3. Grant `allow-<name>` in `src-tauri/capabilities/main.json` and/or `settings.json`. Only the window that needs it.
4. Add a typed wrapper in `src/lib/tauri.ts` and a handler in `src/dev/mock.ts`.

`src-tauri/tests/capabilities.rs` fails when these disagree.

## Data

- Settings: `~/Library/Application Support/com.s3rgiosan.concilia/` holds `config.json`, `rules.json` and `reasons.json`. Debug builds use `*.dev.json`. The service account key is in the Keychain (release) or `service-account.dev.json` (debug).
- Logs: `~/Library/Logs/com.s3rgiosan.concilia/`.
- Each month: `<receipts folder>/<YYYY>/<MM>/` with `receipts/`, `reimbursements/` and `docs/` (`statements.json`, `transactions.json`, `receipts.json` cache, `reimbursements.json`, `match-result.json`, `review-draft.json`, `report.xlsx`, `.applied`). Paths are built in `src-tauri/src/period.rs`.

### Transaction (`match-result.json`)

```json
{
  "id": "tx-001-2030-03-01--1000",
  "date": "2030-03-01",
  "description": "ACME CORP",
  "amount_cents": -1000,
  "abs_cents": 1000,
  "status": "MATCHED",
  "receipt_files": ["<receipts folder>/2030/03/receipts/acme.pdf"],
  "receipt_meta": [{ "file": "…", "amount_cents": 1000, "confidence": "high", "currency": "EUR", "vendor": "ACME", "date": "2030-03-01", "provider_used": "gemini" }],
  "notes": "name_amount_match"
}
```

- `status`: `MATCHED`, `REVIEW` or `UNMATCHED`.
- `notes`: the matcher's code (`name_amount_match`, `amount_match`, `fx_match (USD)`, `rule_match (vendor)`, `manual_match`, `N receipts match amount`, …) or a no-receipt reason id.
- Reason ids: `bank_fee`, `salary`, `transfer`, `refund`, `no_receipt` (Other) or `reason:<uuid>` for user reasons. `model::is_reason_id` and `src/lib/reasons.ts` recognize them, also after the reason is deleted; a deleted reason shows as Other.
- The draft (`review-draft.json`) maps transaction ids to the fields a decision changes, laid over the match result (`review::merge_draft`).

## Matching

`src-tauri/src/matcher.rs`, module doc has the detail. Order: no-receipt rules, bank fees (`bank_fees.rs`), Pass 0 receipt rules, Pass 1 name + exact amount, Pass 2 exact amount, Pass 3 foreign currency ±10%, Pass 4 filename. Exact cents for EUR. Only MATCHED takes a receipt.

## Conventions

- Dates ISO 8601 (`YYYY-MM-DD`); parser output only uses `DD/MM/YYYY`.
- Amounts are signed integer cents; negative is a debit; receipt amounts are positive.
- Every UI string goes in both `src/i18n/locales/en.json` and `pt.json`. Report labels are in `src-tauri/src/excel/strings.rs`. Reason names are data, with an English and a Portuguese name.
- Native surfaces follow the macOS HIG: native menus (`menu.rs`, labels from `useMenu.ts`), alerts through `show_alert`, sheets in the webview (`components/Sheet.tsx`).
- The browser preview (`npm run dev`, `?mock=<scenario>`, `?view=settings`, `?lang=pt`) must work for every screen: keep `src/dev/mock.ts` in step with the commands.
- Test data is fabricated (`ACME CORP`, `GLOBEX`, `EXAMPLE FEE`, dates in 2030). Never copy text, names or amounts from a real statement or receipt.
- Add a `CHANGELOG.md` entry under `## [Unreleased]` for user-facing changes.
- Release tags are plain semver (`2.0.0`) and must match `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.

## Known limitations

- Extraction quality depends on how clear the receipt is.
- Matching runs in transaction order, so with tied amounts the order decides which transaction takes a receipt first.
- Parsers depend on the bank keeping its statement layout.
- Bank description abbreviations may not match the vendor names Gemini reads; rules cover that.

## Mac app UI
- Platforms: macOS, Linux, Windows
- Shape: windowed
