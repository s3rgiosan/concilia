#!/usr/bin/env node

/**
 * CLI: Export match result to Excel (.xlsx).
 *
 * Usage: node export-xlsx.mjs <match-result.json> <output.xlsx> [--lang en|pt]
 */

import { readFileSync } from 'node:fs';
import { writeExcelReport } from '../lib/excel-writer.mjs';

const argv = process.argv.slice(2);
const positional = [];
let lang = 'en';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--lang' && argv[i + 1]) {
    lang = argv[++i];
  } else {
    positional.push(argv[i]);
  }
}

const [inputPath, outputPath] = positional;

if (!inputPath || !outputPath) {
  console.error('Usage: node export-xlsx.mjs <match-result.json> <output.xlsx> [--lang en|pt]');
  process.exit(1);
}

try {
  const result = JSON.parse(readFileSync(inputPath, 'utf8'));
  await writeExcelReport(result, outputPath, { lang });
} catch (err) {
  console.error(`Export failed: ${err.message}`);
  process.exit(1);
}
