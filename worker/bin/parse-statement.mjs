#!/usr/bin/env node

/**
 * CLI wrapper for bank statement parsing.
 *
 * Usage: node parse-statement.mjs <bank> <pdf-path>
 * Output: JSON array of canonical transactions on stdout
 *
 * Calls parsers/parse.mjs via child_process, then normalizes output
 * to the canonical schema: { id, date (ISO), description, amount_cents, abs_cents, status }
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTransaction } from '../lib/schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const [bank, pdfPath] = process.argv.slice(2);

if (!bank || !pdfPath) {
  console.error('Usage: node parse-statement.mjs <bank> <pdf-path>');
  process.exit(1);
}

if (!existsSync(pdfPath)) {
  console.error(`File not found: "${pdfPath}"`);
  process.exit(1);
}

// Locate parsers/parse.mjs relative to this script
// In Docker: /parsers/parse.mjs; locally: ../../parsers/parse.mjs
const dockerPath = '/parsers/parse.mjs';
const localPath = resolve(__dirname, '..', '..', 'parsers', 'parse.mjs');
const parserScript = existsSync(dockerPath) ? dockerPath : localPath;

if (!existsSync(parserScript)) {
  console.error(`Parser script not found at ${dockerPath} or ${localPath}`);
  process.exit(1);
}

try {
  const output = execFileSync('node', [parserScript, bank, pdfPath], {
    encoding: 'utf8',
    timeout: 30000,
  });

  const raw = JSON.parse(output);
  const transactions = raw.map((t, i) => normalizeTransaction(t, i + 1));
  process.stdout.write(JSON.stringify(transactions));
} catch (err) {
  console.error(`Parse failed: ${err.message}`);
  process.exit(1);
}
