#!/usr/bin/env node

/**
 * CLI: Export match result to Excel (.xlsx).
 *
 * Usage: node export-xlsx.mjs <match-result.json> <output.xlsx>
 */

import { readFileSync } from 'node:fs';
import { writeExcelReport } from '../lib/excel-writer.mjs';

const [inputPath, outputPath] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  console.error('Usage: node export-xlsx.mjs <match-result.json> <output.xlsx>');
  process.exit(1);
}

try {
  const result = JSON.parse(readFileSync(inputPath, 'utf8'));
  await writeExcelReport(result, outputPath);
} catch (err) {
  console.error(`Export failed: ${err.message}`);
  process.exit(1);
}
