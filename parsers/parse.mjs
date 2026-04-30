#!/usr/bin/env node

/**
 * CLI entry point for bank statement parsing.
 *
 * Usage: node parse.mjs <bank> <pdf-path>
 * Output: JSON array of transactions on stdout
 *
 * Each transaction: { date: "DD/MM/YYYY", description: "...", amount: -45.99 }
 * Negative amounts = debits, positive = credits.
 */

import { readFileSync, existsSync } from 'node:fs';

// Bank parser registry — add new parsers here
const parsers = {
  cgd: () => import('./cgd.mjs'),
};

const [bank, pdfPath] = process.argv.slice(2);

if (!bank || !pdfPath) {
  console.error('Usage: node parse.mjs <bank> <pdf-path>');
  console.error(`Supported banks: ${Object.keys(parsers).join(', ')}`);
  process.exit(1);
}

const bankKey = bank.toLowerCase();
if (!parsers[bankKey]) {
  console.error(`Unknown bank: "${bank}". Supported: ${Object.keys(parsers).join(', ')}`);
  process.exit(1);
}

if (!existsSync(pdfPath)) {
  console.error(`File not found: "${pdfPath}"`);
  process.exit(1);
}

if (!pdfPath.toLowerCase().endsWith('.pdf')) {
  console.error(`Expected a PDF file, got: "${pdfPath}"`);
  process.exit(1);
}

const buffer = readFileSync(pdfPath);
const { parse } = await parsers[bankKey]();
const transactions = await parse(buffer);

process.stdout.write(JSON.stringify(transactions));
