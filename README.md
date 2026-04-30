# Concilia

Bank statement reconciliation tool. Deterministic parsers extract transactions from bank statement PDFs; Google Gemini extracts amount, currency, vendor, and date from receipts. Matches transactions against receipts, sorts files into 3-way folders, and produces an Excel report. Includes a Review screen for manual corrections and per-receipt AI rescan.

## What it does

1. Extracts transactions from one or more bank statement PDFs (deterministic parser)
2. Reads receipt files from `<year>/<month>/receipts/` (PDF, JPG, PNG)
3. Extracts amount, currency, vendor, and issue date from each receipt using Google Gemini (Vertex AI). Retries up to 3 times on transient failures.
4. Matches transactions to receipts (±€0.05 EUR, ±10% FX) using a four-pass algorithm with name + date disambiguation
5. After user clicks **Apply Changes** in the Review screen, sorts receipts into `receipts/_matched/`, `receipts/_review/`, or `receipts/_unmatched/`
6. Generates an Excel report and saves docs to `<year>/<month>/docs/`

## Requirements

- macOS, Linux, or Synology NAS (DS418Play or similar)
- Docker
- Receipt files accessible from the host filesystem
- Bank statement in PDF format
- Google Cloud account with Vertex AI enabled (required for receipt extraction)

## Setting Up Google Gemini (Vertex AI)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project (or use an existing one)
2. Enable the **Vertex AI API** in APIs & Services
3. Go to **IAM & Admin > Service Accounts** and create a service account
4. Grant it the **Vertex AI User** role (`roles/aiplatform.user`)
5. Create a JSON key for the service account and download it
6. Set the path to the JSON key file in your `.env` as `AI_GEMINI_SA_KEY`

> **Note:** Vertex AI uses pay-per-use pricing. Gemini 2.5 Flash costs ~$0.10/1M input tokens. 200 receipts/month costs ~$0.04. Your data is **never used for model training** under Vertex AI terms. See [Vertex AI pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing).

## Quick Start

```bash
# Clone repository and cd into it
cd concilia

# Configure environment
cp .env.example .env
# Edit .env to set RECEIPTS_PATH, TZ, and AI_GEMINI_SA_KEY

# Start services
npm start

# Open web UI
open http://localhost:3000
```

## How it works

```text
Bank PDF  ──▶ Deterministic Parser ──┐
                                     ├──▶ Four-Pass Matching ──▶ Sort Files ──▶ Excel Report
Receipts  ──▶ Gemini AI Extraction ──┘
```

- **Express server**: Lightweight web UI + API orchestration (Docker)
- **Bank statement parsing**: Deterministic JS parsers using `pdfjs-dist` (no AI needed)
- **Receipt extraction**: Google Gemini for amount, currency, vendor, and date extraction (with automatic retries)
- **Review UI**: Manual matching, per-receipt rescan button, accept/reject candidates
- **Worker scripts**: Standalone CLI tools in `worker/` for parsing, extraction, matching, and export

## Project Structure

```text
concilia/
├── .github/workflows/ci.yml  # CI: tests + Docker build/push to GHCR (amd64 + arm64)
├── .dockerignore              # Excludes .git, tests, .env from build context
├── .env.example               # Environment config template
├── Dockerfile                 # Multi-stage: poppler + client build + server
├── docker-compose.yml         # Pulls image from GHCR, configures container
├── package.json               # Scripts + test runner (no runtime deps)
├── client/                    # React + Vite + Tailwind web UI
│   └── src/
│       ├── App.tsx            # Main app (form → progress → results)
│       └── components/        # ReconcileForm, ProgressCard, ResultsCard
├── server/                    # Express API server
│   ├── index.mjs              # Routes: POST /api/reconcile, GET /report/:year/:month
│   └── reconcile.mjs          # Orchestration (calls worker CLIs, SSE progress)
├── parsers/                   # Bank statement parsers (deterministic, no AI)
│   ├── package.json           # pdfjs-dist dependency
│   ├── parse.mjs              # CLI entry point
│   ├── cgd.mjs                # CGD parser
│   └── utils.mjs              # Shared utilities
├── worker/                    # Standalone worker scripts
│   ├── package.json           # ESM config + exceljs dependency
│   ├── lib/                   # Shared libraries
│   │   ├── schema.mjs         # Canonical schema (dates, amounts, IDs)
│   │   ├── gemini.mjs         # Google Gemini AI provider
│   │   ├── bank-fees.mjs      # Bank fee detection patterns
│   │   ├── matcher.mjs        # Transaction-receipt matching engine
│   │   └── excel-writer.mjs   # Excel output (exceljs)
│   └── bin/                   # CLI entry points
│       ├── parse-statement.mjs    # Parse bank statement → canonical JSON
│       ├── receipt-meta.mjs       # Extract receipt metadata via Gemini
│       ├── extract-receipts.mjs   # Batch receipt extraction from file list
│       ├── match.mjs              # Match transactions ↔ receipts
│       └── export-xlsx.mjs        # Export match results to Excel
└── tests/
    └── worker/                # Test files (node:test, 170 tests)
        ├── schema.test.js
        ├── cgd.test.js
        ├── parse-statement.test.js
        ├── gemini.test.js
        ├── receipt-meta.test.js
        ├── extract-receipts.test.js
        ├── bank-fees.test.js
        ├── matcher.test.js
        ├── match.test.js
        ├── export-xlsx.test.js
        └── excel-writer.test.js
```

## Usage

1. Drop receipts into `<RECEIPTS_PATH>/YYYY/MM/receipts/` (PDF, JPG, PNG)
2. Open the web UI at <http://localhost:3000>
3. Select **Year** and **Month**
4. Upload one or more bank statement PDFs, selecting the bank for each
5. Click **Run Reconciliation** and watch live progress
6. Open the **Review** screen to inspect matches:
   - 👁 Preview a receipt
   - 🔄 Rescan a receipt with Gemini (retry extraction if amount/vendor was missed)
   - ✓ Accept / ✗ Reject candidates, manually assign receipts to unmatched transactions
7. Click **Apply Changes** to move files into 3-way folders and regenerate the Excel report
8. Download the report (filename: `YYYY-MM.xlsx`)

**Folder layout after processing:**

```text
Receipts/2024/12/
├── receipts/
│   ├── _matched/      ← Matched receipts (send to accountant)
│   │   ├── receipt1.pdf
│   │   └── receipt2.jpg
│   ├── _review/       ← Ambiguous matches (needs manual review)
│   │   └── receipt3.pdf
│   ├── _unmatched/    ← Unmatched receipts
│   │   └── receipt4.pdf
│   └── (any new receipts dropped here for the next run)
└── docs/              ← Reports and data
    ├── report.xlsx
    ├── transactions.json
    ├── receipts.json
    └── match-result.json
```

## Excel Output

| id | date | description | amount | status | receipt_file(s) | notes |
|----|------|-------------|--------|--------|-----------------|-------|
| tx-001-... | 2024-12-15 | COMPRA AMAZON | -45.99 | MATCHED | receipts/_matched/receipt.pdf | amount_match |
| tx-002-... | 2024-12-16 | RESTAURANTE X | -23.50 | UNMATCHED | | |
| tx-003-... | 2024-12-17 | COMPRA Y | -50.00 | REVIEW | a.pdf; b.pdf | 2 receipts match |
| tx-004-... | 2024-12-18 | COMISSÃO | -2.50 | MATCHED | | bank_fee |

Status column is color-coded: green (MATCHED), amber (REVIEW), red (UNMATCHED).

## Matching

Four-pass matching:

**Pass 1 — name + amount (EUR, ±€0.05):**
- Receipt filename or vendor name matches transaction description AND amount within ±€0.05
- **Bank fee pattern** → `MATCHED` (auto, no receipt needed)

**Pass 2 — amount only (EUR, ±€0.05):**
- EUR receipts matched by amount only
- Name overlap used to disambiguate multiple candidates

**Pass 3 — foreign currency (±10%):**
- Non-EUR receipts (USD, GBP, etc.) matched within ±10% of transaction amount
- Always `REVIEW` (human verifies FX conversion)

**Pass 4 — filename only:**
- Remaining transactions matched by vendor name in receipt filename
- e.g., transaction "DIGITALOCEAN" matches `DigitalOcean Invoice 2025 Oct.pdf`
- Always `REVIEW` (human verifies)
- **No matches** → `UNMATCHED`

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start container |
| `npm stop` | Stop container |
| `npm restart` | Restart container |
| `npm run update` | Pull latest image and restart |
| `npm test` | Run all tests (170) |
| `npm run build` | Build React client locally |
| `npm run logs` | Tail container logs |
| `npm run shell` | Open a shell inside the container |
| `npm run clean` | Stop container and remove volumes |

## Updating

Docker images are built and pushed to GitHub Container Registry automatically when changes are merged to `main`. Multi-arch: `linux/amd64` and `linux/arm64` (Synology NAS).

To update a running instance:

```bash
npm run update
```

This pulls the latest image from GHCR and restarts the container.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RECEIPTS_PATH` | Yes | — | Absolute path to receipts folder on host |
| `AI_GEMINI_SA_KEY` | Yes | — | Path to service account JSON key file |
| `AI_GEMINI_PROJECT` | No | (from key file) | GCP project ID |
| `AI_GEMINI_LOCATION` | No | `europe-west1` | GCP region |
| `AI_GEMINI_MODEL` | No | `gemini-2.5-flash` | Gemini model |
| `TZ` | No | `Europe/Lisbon` | Timezone (IANA format) |
| `PORT` | No | `3000` | Host port |

## Synology NAS Deployment

Concilia runs on Synology NAS devices with Docker support (e.g., DS418Play). The Docker image is built for `linux/amd64` and `linux/arm64`.

### 1. Copy project to Synology

```bash
# From your local machine
scp -r concilia/ user@synology:/volume1/docker/concilia/
```

Or clone the repository directly on the NAS via SSH.

### 2. Configure environment

```bash
ssh user@synology
cd /volume1/docker/concilia
cp .env.example .env
```

Edit `.env`:

```bash
RECEIPTS_PATH=/volume1/Receipts
TZ=Europe/Lisbon
AI_GEMINI_SA_KEY=/volume1/docker/concilia/sa-key.json
```

### 3. Start

```bash
docker compose up -d
```

### 4. Set up external access via Synology Reverse Proxy

1. Open **Control Panel > Login Portal > Advanced > Reverse Proxy**
2. Click **Create** and configure:
   - **Description**: Concilia
   - **Source**: Protocol `HTTPS`, Hostname `concilia.yourdomain.com`, Port `443`
   - **Destination**: Protocol `HTTP`, Hostname `localhost`, Port `3000`
3. Set up a DNS record (A or CNAME) pointing `concilia.yourdomain.com` to your Synology's public IP
4. In **Control Panel > Security > Certificate**, add an SSL certificate for your domain (Let's Encrypt works)

### 5. Access

- **Local**: `http://synology-ip:3000`
- **External**: `https://concilia.yourdomain.com`

### 6. Update

```bash
cd /volume1/docker/concilia
docker compose pull && docker compose up -d
```

## License

MIT License - see [LICENSE](LICENSE)

## Contributing

Issues and PRs welcome.
