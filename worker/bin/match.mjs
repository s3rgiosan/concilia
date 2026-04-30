#!/usr/bin/env node

/**
 * CLI: Match transactions against receipts.
 *
 * Usage: node match.mjs <transactions.json> <receipts.json>
 * Output: JSON match result on stdout
 */

import { readFileSync, existsSync } from 'node:fs';
import { matchTransactions } from '../lib/matcher.mjs';

const args = process.argv.slice(2);
const [txPath, rcptPath] = args;

if (!txPath || !rcptPath) {
  console.error('Usage: node match.mjs <transactions.json> <receipts.json> [rules.json]');
  process.exit(1);
}

const rulesPath = args[2] || null;

try {
  const transactions = JSON.parse(readFileSync(txPath, 'utf8'));
  const receipts = JSON.parse(readFileSync(rcptPath, 'utf8'));
  const rules = rulesPath && existsSync(rulesPath) ? JSON.parse(readFileSync(rulesPath, 'utf8')) : [];

  const result = matchTransactions(transactions, receipts, rules);
  process.stdout.write(JSON.stringify(result));
} catch (err) {
  console.error(`Match failed: ${err.message}`);
  process.exit(1);
}
