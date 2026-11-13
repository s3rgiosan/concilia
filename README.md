<p align="center"><img src="src-tauri/icons/128x128@2x.png" alt="Concilia icon" width="128" height="128"></p>

# Concilia

Desktop app for bank statement reconciliation. Reads transactions from bank statement PDFs, reads receipts (PDF, JPG, PNG) with Google Gemini, matches them, sorts the receipt files into matched, review and unmatched folders, and writes an Excel report.

Built with Tauri: a Rust backend and a React webview. Released for macOS on Apple silicon; CI also checks Linux and Windows.

## Features

- **Local first**: one user, files stay in your receipts folder. Only receipts go to Gemini to be read.
- **English and Portuguese**: the app and the report follow the chosen language, or the system's.
- **Statement parsing**: deterministic per-bank parsers, no AI. CGD today. Every PDF operation uses poppler (`pdftotext`, `pdftoppm`), bundled in the app.
- **Receipt extraction**: Gemini on Google's Gemini Enterprise Agent Platform (formerly Vertex AI) reads amount, currency, vendor and issue date. Four receipts at a time, up to three attempts each. High-confidence results are cached per month, so a receipt is read once.
- **Matching**: user rules first, then name and amount, amount only, foreign currency and filename passes. See [Matching](#matching).
- **Review**: each month goes from receipts and statements to a review list with a details column. Assign, reject or mark a transaction as needing no receipt, give one transaction several receipts, read a receipt again, add more statements, and scan for new receipts without losing decisions. Decisions save as you go.
- **Finalize and reopen**: Finalize moves each receipt into `_matched`, `_review` or `_unmatched` and saves the report. Reopen Month brings a finalized month back to review with every decision kept.
- **Rules and reasons**: rules link a receipt vendor to a transaction description, or mark a transaction as needing no receipt for a reason. The reasons (Bank Fee, Salary, Transfer, Refund, Other, plus your own) are editable in Settings, in English and Portuguese.
- **Reimbursements**: receipts paid personally go in `<year>/<month>/reimbursements/`. Concilia reads them, never matches them, and lists them on their own report sheet.
- **Native macOS**: native menus and shortcuts, alerts as sheets, the system accent colour, dark mode, zoom, and a translucent sidebar.
- **Updates**: Concilia checks GitHub releases a minute after launch and daily, and installs a signed update from the app.

## Tech Stack

- **Shell**: Tauri 2
- **Backend**: Rust (matching, statement parsing, Gemini client, Excel report, file moves)
- **Frontend**: React 19, TypeScript, Vite, react-i18next
- **PDF**: bundled poppler, `pdftotext` for text and `pdftoppm` for page images
- **AI**: Google Gemini (default `gemini-2.5-flash`), service-account JWT auth
- **Excel**: rust_xlsxwriter
- **Tests**: Vitest for the frontend, `cargo test` for the backend

## Project Structure

```text
concilia/
├── src/              # React frontend: main window (main/), review (review/), Settings (settings/)
│   ├── lib/          # Tauri command wrappers (tauri.ts), menus, hooks
│   ├── i18n/         # en and pt strings
│   └── dev/mock.ts   # browser preview backend
├── src-tauri/        # Rust backend and app config
│   ├── src/          # commands, matcher, bank parsers, Gemini, Excel, pipeline, menus
│   ├── tests/        # integration tests and golden fixtures
│   └── capabilities/ # which commands each window may call
├── docs/wiring.md    # menus, alerts, events and permissions
├── scripts/          # poppler bundling, app icon, symbol export
├── worker/, parsers/ # Node reference implementation, kept for comparison (npm run test:legacy)
└── tests/worker/     # tests for the Node reference implementation
```

## Getting Started

### Install

Download the DMG from the [latest release](https://github.com/s3rgiosan/concilia/releases/latest), open it and drag `Concilia.app` into `/Applications`. The app is ad-hoc signed, not notarized, so on first launch macOS Gatekeeper says "Concilia is damaged and can't be opened". Remove the quarantine attribute once:

```bash
xattr -dr com.apple.quarantine /Applications/Concilia.app
```

Then open it normally.

### Build from source

Needs Node 22, Rust (stable), Xcode Command Line Tools and [poppler](https://poppler.freedesktop.org/) (`brew install poppler`).

```bash
git clone https://github.com/s3rgiosan/concilia.git
cd concilia
npm ci
npm run bundle:poppler       # copies pdftotext + pdftoppm and their libraries into build/poppler/
npm run tauri build -- --config '{"bundle":{"resources":{"../build/poppler":"poppler"}}}'
```

The DMG lands in `src-tauri/target/release/bundle/dmg/`. Add `--bundles app` to build only `Concilia.app`.

### Development

```bash
npm run tauri dev            # the app with hot reload; uses poppler from PATH
npm run dev                  # browser preview with a mock backend, http://localhost:1420
```

The preview takes `?mock=<scenario>` (`first-run`, `configured`, `resume`, `applied`, `busy`, `update`, …; list in `src/dev/mock.ts`), `?view=settings` and `?lang=en|pt`.

Debug builds keep their own settings files (`*.dev.json`) and store the key in a file, not the Keychain, so they never touch a release build's setup.

### Settings and data

Settings live in `~/Library/Application Support/com.s3rgiosan.concilia/`:

| File | Holds |
|---|---|
| `config.json` | language, receipts folder, Gemini project, location and model, update checks |
| `rules.json` | match rules and no-receipt rules |
| `reasons.json` | no-receipt reasons; absent until you change them |

The service account key lives in the Keychain. Logs go to `~/Library/Logs/com.s3rgiosan.concilia/`.

## Setting up Google Gemini (Agent Platform)

Concilia uses Gemini on Google's Gemini Enterprise Agent Platform (formerly Vertex AI) to read receipts. You need a Google Cloud project with the Agent Platform API enabled and a service-account JSON key. Follow the steps below — the whole flow takes ~5 minutes.

### 1. Create or select a Google Cloud project

1. Sign in to the [Google Cloud Console](https://console.cloud.google.com).
2. Click the project picker in the top bar → **New Project**.
3. Give it a name (e.g. `concilia`) and click **Create**.
4. Once created, make sure it's selected in the project picker — every subsequent step assumes this project is active.

> First-time Google Cloud users get a $300 free trial credit. After that, Agent Platform is pay-per-use (see pricing note at the bottom).

### 2. Enable billing

Agent Platform requires a billing account, even though monthly cost is typically a few cents.

1. Go to **Billing** ([direct link](https://console.cloud.google.com/billing)).
2. Link a billing account to the project (create one if you don't have any).

### 3. Enable the Agent Platform API

1. Open the Agent Platform API page: <https://console.cloud.google.com/apis/library/aiplatform.googleapis.com>.
2. Make sure your project is selected in the top bar.
3. Click **Enable**. Wait ~30 seconds for activation.

### 4. Create a service account

1. Go to **IAM & Admin → Service Accounts** ([direct link](https://console.cloud.google.com/iam-admin/serviceaccounts)).
2. Click **+ Create service account**.
3. Fill in:
   - **Service account name**: `concilia` (or any name you like)
   - **Service account ID**: auto-fills (e.g. `concilia`)
   - **Description**: optional
4. Click **Create and continue**.
5. Under **Grant this service account access to project**, add the role:
   - **Agent Platform User** (`roles/aiplatform.user`)
6. Click **Continue**, then **Done**. You'll be returned to the service-accounts list.

### 5. Generate a JSON key

1. In the service-accounts list, click your new account (e.g. `concilia@<project>.iam.gserviceaccount.com`).
2. Open the **Keys** tab.
3. Click **Add key → Create new key**.
4. Select **JSON** and click **Create**.
5. The browser downloads a `.json` file (e.g. `concilia-abc123.json`). **Save this file in a safe location** — e.g. `~/.config/concilia/sa-key.json`. You can't re-download it; if lost, generate a new key.

> Treat this file as a password. Anyone with it can call Agent Platform on your billing account. Don't commit it to git, don't email it.

### 6. Import the key into Concilia

- On first launch, the Welcome screen asks for the receipts folder and the key: click **Import…** next to **Gemini key** and pick the `.json` file.
- Later, open **Settings › Gemini** and click **Import Key File…**.

Concilia copies the key into the macOS Keychain, so the file can be moved or deleted afterwards. Project, Location and Model can stay as they are: the project comes from the key, and the defaults are `europe-west1` and `gemini-2.5-flash`.

### Pricing & privacy

Agent Platform is pay-per-use. Gemini 2.5 Flash costs ~$0.10/1M input tokens. ~200 receipts/month ≈ $0.04. Data sent to Agent Platform is **not used to train Google models** under the Agent Platform terms — see [Agent Platform pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing) and [data governance](https://cloud.google.com/vertex-ai/generative-ai/docs/data-governance).

## Usage

1. Put receipts in `<receipts folder>/YYYY/MM/receipts/` (PDF, JPG, PNG).
2. Open Concilia. On first launch, choose the receipts folder and import the Gemini key.
3. Pick a month in the sidebar (**New Month…** creates one), then drop its bank statement PDFs on the window or use **Add Statements…**.
4. Click **Reconcile**. Concilia parses the statements, reads the receipts and matches them.
5. Review the month. **To Decide** lists what needs you. For each transaction:
   - **Assign** a suggested receipt, or **None of These**;
   - **No Receipt Needed** with a reason;
   - **Add Receipt…** for a transaction paid with several receipts;
   - **Read Receipt Again** when Gemini misread one.
   Right-click a decided transaction for **Always Match** or **Always Mark**, which add a rule.
6. Add receipts to the folder at any time and use **Scan for New Receipts**. **Export Report…** saves the report with the decisions so far.
7. **Finalize…** sorts the receipts and saves the report. To change a finalized month, use **Month › Reopen Month…**. **Reconcile Again…** reads every receipt again and keeps your review decisions.

Folder layout after Finalize:

```text
<receipts folder>/2030/03/
├── receipts/
│   ├── _matched/          ← matched receipts (send to the accountant)
│   ├── _review/           ← candidates left undecided
│   ├── _unmatched/        ← receipts no transaction took
│   └── (new receipts dropped here are read on the next scan)
├── reimbursements/        ← receipts paid personally (optional)
└── docs/
    ├── report.xlsx
    ├── transactions.json, statements.json
    ├── receipts.json, reimbursements.json   ← extraction cache
    ├── match-result.json
    └── review-draft.json  ← decisions not yet finalized
```

## Supported Banks

- **CGD (Caixa Geral de Depósitos)**, Portugal

To add a bank, see [`.github/BANK_PARSER_GUIDE.md`](.github/BANK_PARSER_GUIDE.md).

## Excel output

Sheet names and headers follow the app language.

- **Totals**: the sums of transactions marked with the Other reason, of unmatched receipts, and of reimbursements when there are any.
- **All Transactions**: one row per transaction with status (green MATCHED, amber REVIEW, red UNMATCHED), receipt names, amounts, confidence, currency and notes. A no-receipt transaction shows its reason's name.
- **Matched** / **Needs Review**: one row per receipt of a MATCHED or REVIEW transaction, with the transaction's date, description and amount.
- **Unmatched**: receipts no transaction uses.
- **Reimbursements**: receipts under `reimbursements/` with a total. Only when there are any.

## Matching

Exact cents for EUR receipts, ±10% for foreign-currency receipts, and a 45-day date window to break ties. Passes run in order; each looks only at transactions still UNMATCHED:

- **No-receipt rules**: a description keyword marks the transaction MATCHED with the rule's reason. Then bank fees (built-in Portuguese and English patterns) are MATCHED as Bank Fee.
- **Pass 0, rules**: vendor keyword plus description keyword. One receipt with a fitting amount is MATCHED; several, or none that fits, are REVIEW.
- **Pass 1, name and exact amount**: EUR receipts; receipts of unknown currency go to REVIEW.
- **Pass 2, exact amount**: EUR receipts, name overlap breaks ties; unknown currency goes to REVIEW.
- **Pass 3, foreign currency** within ±10% with a shared name word: REVIEW.
- **Pass 4, filename**: receipts sharing a name word, except EUR receipts whose known amount differs: REVIEW.
- Nothing found: UNMATCHED.

Only MATCHED takes a receipt; REVIEW candidates stay available to other transactions.

## Testing

```bash
npm test                     # frontend (Vitest)
npm run typecheck && npm run lint
cd src-tauri && cargo test   # backend; tests that need poppler skip without it on PATH
cargo fmt --check && cargo clippy --all-targets -- -D warnings
npm run test:legacy          # Node reference implementation
```

## License

[GPL-3.0-or-later](LICENSE)
