#!/usr/bin/env node

/**
 * Extract metadata from all receipt files in a list.
 *
 * Usage: node extract-receipts.mjs <file-list-path> --sa-key PATH [--project ID] [--location REGION] [--model MODEL]
 *
 * Input: text file with one receipt path per line
 * Output: JSON array of receipt metadata on stdout
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const receiptMetaScript = join(__dirname, 'receipt-meta.mjs');

function parseArgs(argv) {
  const args = { fileList: null, saKey: null, project: null, location: null, model: null, cache: null, force: false };
  let i = 0;
  while (i < argv.length) {
    if (argv[i] === '--sa-key' && argv[i + 1]) {
      args.saKey = argv[++i];
    } else if (argv[i] === '--project' && argv[i + 1]) {
      args.project = argv[++i];
    } else if (argv[i] === '--location' && argv[i + 1]) {
      args.location = argv[++i];
    } else if (argv[i] === '--model' && argv[i + 1]) {
      args.model = argv[++i];
    } else if (argv[i] === '--cache' && argv[i + 1]) {
      args.cache = argv[++i];
    } else if (argv[i] === '--force') {
      args.force = true;
    } else if (!argv[i].startsWith('-')) {
      args.fileList = argv[i];
    }
    i++;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!args.fileList || !args.saKey) {
  console.error('Usage: node extract-receipts.mjs <file-list-path> --sa-key PATH [--project ID] [--location REGION] [--model MODEL] [--cache PATH] [--force]');
  process.exit(1);
}

// Load cache of previously extracted receipts (confidence:high only)
const cacheMap = new Map();
if (args.cache && !args.force) {
  try {
    const cached = JSON.parse(readFileSync(args.cache, 'utf8'));
    for (const entry of cached) {
      if (entry.file && entry.confidence === 'high') cacheMap.set(entry.file, entry);
    }
  } catch { /* cache missing or invalid — proceed without */ }
}

const files = readFileSync(args.fileList, 'utf8').split('\n').filter(f => f.trim() !== '');
const receipts = [];

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [0, 1500, 4000];

for (const f of files) {
  if (cacheMap.has(f)) {
    console.error(`[extract-receipts] cache hit: ${f}`);
    receipts.push(cacheMap.get(f));
    continue;
  }
  const cmdArgs = [receiptMetaScript, f, '--sa-key', args.saKey];
  if (args.model) cmdArgs.push('--model', args.model);
  if (args.project) cmdArgs.push('--project', args.project);
  if (args.location) cmdArgs.push('--location', args.location);

  let result = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (BACKOFF_MS[attempt] > 0) {
      console.error(`[extract-receipts] retry ${attempt}/${MAX_ATTEMPTS - 1} after ${BACKOFF_MS[attempt]}ms: ${f}`);
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
    }
    try {
      const out = execFileSync('node', cmdArgs, { encoding: 'utf8', timeout: 180000 });
      const parsed = JSON.parse(out);
      result = parsed;
      // Stop retrying if we got a usable amount
      if (parsed.amount_cents != null) break;
      console.error(`[extract-receipts] null amount on attempt ${attempt + 1}: ${f}`);
    } catch (err) {
      console.error(`[extract-receipts] attempt ${attempt + 1} failed: ${f} — ${err.message}`);
    }
  }
  receipts.push(result || { file: f, amount_cents: null, confidence: null, currency: null, vendor: null, date: null, provider_used: 'error' });
}

process.stdout.write(JSON.stringify(receipts));
