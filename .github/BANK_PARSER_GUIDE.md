# Bank Statement Parser Contributor Guide

This guide walks you through adding a new bank statement parser to Concilia. Follow these steps exactly and open a PR.

---

## Architecture Overview

```text
PDF Buffer
  |
  v
Parser (parsers/<bank-slug>.mjs)
  |  - Extracts text via parsers/utils.mjs::extractTextWithPoppler (poppler `pdftotext -layout`)
  |  - Parses transactions: { date, description, amount }
  |
  v
parsers/parse.mjs (CLI dispatch)
  |  - Looks up parser by bank key in `parsers` registry
  |  - node parse.mjs <bank> <pdf-path> → JSON to stdout
  |
  v
worker/bin/parse-statement.mjs (canonical-schema wrapper)
  |  - Calls parsers/parse.mjs via execFileSync
  |  - Normalizes output via worker/lib/schema.mjs::normalizeTransaction
  |  - Adds: id (deterministic), ISO date, amount_cents, abs_cents, status="UNMATCHED"
  |
  v
server/reconcile.mjs
  |  - Spawns parse-statement.mjs per uploaded PDF
  |  - Merges transactions, dedupes by tx.id
  |  - Continues to extract / match / export
```

## Files to Touch (3 files, +1 optional)

| # | File | Action |
|---|------|--------|
| 1 | `parsers/<bank-slug>.mjs` | Create parser exporting `async function parse(buffer)` |
| 2 | `parsers/parse.mjs` | Add 1 line to the `parsers` registry |
| 3 | `client/src/components/ReconcileForm.tsx` | Add 1 line to the `BANKS` array |
| 4 | `tests/worker/<bank-slug>.test.js` | (Optional but recommended) Unit tests |

No changes to `worker/bin/parse-statement.mjs`, `worker/lib/schema.mjs`, `server/reconcile.mjs`, or `electron/`.

## Parser Contract

### Signature

```js
// parsers/<bank-slug>.mjs
export async function parse(buffer) {
  // buffer: Buffer (raw PDF bytes)
  // returns: Promise<Transaction[]>
}
```

### Output schema

```js
{
  date: "DD/MM/YYYY",      // European format — converted to ISO downstream
  description: "...",       // Trimmed transaction description
  amount: -45.99,           // Signed JS number; negative = debit, positive = credit
}
```

### Rules

1. **Input:** `Buffer` (raw PDF bytes).
2. **Output:** `Promise<Array<{ date, description, amount }>>`.
3. **Date format:** `DD/MM/YYYY`. The downstream `normalizeTransaction()` converts to ISO 8601 (`YYYY-MM-DD`).
4. **Amount sign:** signed JS number. Negative = debit/expense, positive = credit/income.
5. **Amount precision:** keep 2 decimals as a JS number. Downstream `euroToCents()` converts to integer cents.
6. **Description:** trimmed, single-spaced. The description is what the matcher uses against receipt vendor names.
7. **No IDs:** `parse-statement.mjs` generates deterministic IDs (`tx-NNN-YYYY-MM-DD--CENTS`).
8. **No status field:** the wrapper sets `status: "UNMATCHED"` on every transaction.

## Step-by-Step Implementation

### Step 1: Create the Parser

**File:** `parsers/<bank-slug>.mjs`

Use `extractTextWithPoppler` from `parsers/utils.mjs` (shells out to `pdftotext -layout` and returns an array of text lines with column whitespace preserved). Use `parseEuropeanDecimal` for `1.234,56`-format strings.

```js
import { extractTextWithPoppler, parseEuropeanDecimal } from './utils.mjs';

/**
 * Parser for <Bank Name>.
 *
 * Algorithm: extract text → match transaction lines → extract date,
 * description, signed amount. Convert date to DD/MM/YYYY.
 */

/**
 * @param {Buffer} buffer
 * @returns {Promise<Array<{date: string, description: string, amount: number}>>}
 */
export async function parse(buffer) {
  const lines = extractTextWithPoppler(buffer);
  const transactions = [];

  // TODO: write a regex / line-detection rule for your bank's transaction line format.
  // Example: lines starting with a date in DD.MM.YYYY format
  const linePattern = /^(\d{2}\.\d{2}\.\d{4})\s+(.+?)\s+(-?[\d.]+,\d{2})\s+(-?[\d.]+,\d{2})\s*$/;

  for (const line of lines) {
    const m = line.match(linePattern);
    if (!m) continue;

    const [, dateStr, rawDesc, amountStr /* , balanceStr */] = m;
    const description = rawDesc.replace(/\s+/g, ' ').trim();
    if (!description) continue;

    // Convert DD.MM.YYYY → DD/MM/YYYY (or whatever your bank uses)
    const date = dateStr.replace(/\./g, '/');
    const amount = parseEuropeanDecimal(amountStr);

    transactions.push({ date, description, amount });
  }

  return transactions;
}
```

If your bank uses a different decimal format (e.g. `1,234.56`), write a local helper instead of `parseEuropeanDecimal`.

### Step 2: Register the Parser

**File:** `parsers/parse.mjs`

Add one line to the `parsers` registry:

```js
const parsers = {
  cgd: () => import('./cgd.mjs'),
  yourbank: () => import('./yourbank.mjs'),    // ← add this
};
```

The bank key is the lowercase string the UI sends. Keep it short, snake_case-free, alphanumeric.

### Step 3: Add the Bank to the UI

**File:** `client/src/components/ReconcileForm.tsx`

Add one entry to `BANKS`:

```ts
const BANKS = [
  { value: 'cgd', label: 'CGD' },
  { value: 'yourbank', label: 'Your Bank' },    // ← add this
];
```

`value` MUST exactly match the key you registered in `parsers/parse.mjs`. `label` is the user-facing dropdown text.

### Step 4: Tests (recommended)

**File:** `tests/worker/<bank-slug>.test.js`

Use `node:test` (built into Node ≥ 18). Tests are CommonJS but load ESM parsers via dynamic `import()`.

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('<bank> parser', () => {
  it('parses a sample line', async () => {
    const { parse } = await import('../../parsers/yourbank.mjs');
    // Build a minimal Buffer that exercises your line-matching logic, OR
    // load a fixture PDF: const buf = fs.readFileSync('tests/fixtures/yourbank-sample.pdf');
    // const txs = await parse(buf);
    // assert.equal(txs.length, 3);
    // assert.deepEqual(txs[0], { date: '15/01/2025', description: 'COMPRA SHOPCO', amount: -45.99 });
  });
});
```

If you also write helper functions worth unit-testing in isolation, export them from your parser and test them directly:

```js
// parsers/yourbank.mjs
export function parseYourbankDate(s) { /* ... */ }
```

```js
// tests/worker/yourbank.test.js
const { parseYourbankDate } = await import('../../parsers/yourbank.mjs');
assert.equal(parseYourbankDate('15.01.2025'), '15/01/2025');
```

## Verification Commands

Run from the repo root before opening your PR:

```bash
# Run all worker tests (includes your new parser test)
npm test

# Smoke-test the parser end-to-end against a real PDF
node parsers/parse.mjs yourbank /path/to/sample.pdf

# Wrapper-level smoke test (canonical schema output)
node worker/bin/parse-statement.mjs yourbank /path/to/sample.pdf
```

`parsers/parse.mjs` should print a JSON array like:

```json
[{"date":"15/01/2025","description":"COMPRA SHOPCO","amount":-45.99}, ...]
```

`worker/bin/parse-statement.mjs` should print canonical schema:

```json
[{"id":"tx-001-2025-01-15--4599","date":"2025-01-15","description":"COMPRA SHOPCO","amount_cents":-4599,"abs_cents":4599,"status":"UNMATCHED"}, ...]
```

## Tips for Writing Parsers

- **Inspect the PDF first.** Run `extractTextWithPoppler(fs.readFileSync('sample.pdf'))` and dump the line array to understand the layout `pdftotext -layout` gives you. Whitespace within each line is preserved, so column alignment from the original PDF carries through.
- **Anchor on the date.** Bank statements are line-oriented around dates. Matching on a leading date pattern is the most reliable line-detection approach.
- **Handle the balance column.** Most statements end transaction lines with a running balance. Use the **second-to-last** decimal as the transaction amount, not the last.
- **Watch sign conventions.** Some banks render debits as `-45,99`, others as `45,99 D` or in a separate column. Detect the sign explicitly — don't assume.
- **Match the right description boundaries.** Strip column separators, double spaces, and trailing reference codes. Vendor names are matched against receipts later, so accuracy here improves match rates.
- **Multi-page PDFs:** `extractTextWithPoppler` already concatenates across pages. Header/footer text repeats per page — your line filter needs to ignore it.
- **Don't AI it.** Bank parsing is deterministic. Don't introduce LLM calls in `parsers/`. AI lives in `worker/lib/gemini.mjs` and is only used for receipt extraction.

## PR Checklist

- [ ] Parser created at `parsers/<bank-slug>.mjs`
- [ ] Parser exports a named `async function parse(buffer)`
- [ ] Output uses `DD/MM/YYYY` dates and signed JS numbers (negative = debit)
- [ ] Description is trimmed and single-spaced
- [ ] Parser registered in `parsers/parse.mjs`
- [ ] Bank added to `BANKS` array in `client/src/components/ReconcileForm.tsx` (matching `value` key)
- [ ] Tests added under `tests/worker/<bank-slug>.test.js` (optional but recommended)
- [ ] `npm test` passes
- [ ] End-to-end smoke test: `node worker/bin/parse-statement.mjs <bank> sample.pdf` produces canonical schema
