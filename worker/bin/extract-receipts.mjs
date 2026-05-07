#!/usr/bin/env node

/**
 * Extract metadata from all receipt files in a list.
 *
 * Usage: node extract-receipts.mjs <file-list-path> [--project ID] [--location REGION] [--model MODEL] [--cache PATH] [--force]
 *
 * Input: text file with one receipt path per line
 * Output: JSON array of receipt metadata on stdout
 *
 * Auth: AI_GEMINI_SA_KEY env var must point at the service-account JSON key.
 * The path is forwarded to receipt-meta.mjs via the env so it does not appear
 * in `ps -ef` output.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const receiptMetaScript = join(__dirname, 'receipt-meta.mjs');
const NODE_BIN = process.env.NODE_BIN || process.execPath;
const NODE_ENV_EXTRA = process.env.NODE_BIN ? { ELECTRON_RUN_AS_NODE: '1' } : {};

function parseArgs(argv) {
  const args = { fileList: null, project: null, location: null, model: null, cache: null, force: false };
  let i = 0;
  while (i < argv.length) {
    if (argv[i] === '--project' && argv[i + 1]) {
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

if (!args.fileList) {
  console.error('Usage: node extract-receipts.mjs <file-list-path> [--project ID] [--location REGION] [--model MODEL] [--cache PATH] [--force]');
  process.exit(1);
}
if (!process.env.AI_GEMINI_SA_KEY) {
  console.error('Error: AI_GEMINI_SA_KEY env var is required (path to service-account JSON key)');
  process.exit(1);
}

// Load cache of previously extracted receipts (confidence: 'high' only).
// Low-confidence and null entries are re-extracted on next run — they
// often improve with retry, and a wrong cached amount is worse than a
// few extra Gemini calls.
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

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [0, 1500, 4000];
const CONCURRENCY = 4;

async function extractOne(f) {
  if (cacheMap.has(f)) {
    console.error(`[extract-receipts] cache hit: ${f}`);
    return cacheMap.get(f);
  }
  const cmdArgs = [receiptMetaScript, f];
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
      const { stdout } = await execFileAsync(NODE_BIN, cmdArgs, { encoding: 'utf8', timeout: 180000, env: { ...process.env, ...NODE_ENV_EXTRA }, maxBuffer: 5 * 1024 * 1024 });
      const parsed = JSON.parse(stdout);
      result = parsed;
      if (parsed.amount_cents != null) break;
      console.error(`[extract-receipts] null amount on attempt ${attempt + 1}: ${f}`);
    } catch (err) {
      console.error(`[extract-receipts] attempt ${attempt + 1} failed: ${f} — ${err.message}`);
    }
  }
  return result || { file: f, amount_cents: null, confidence: null, currency: null, vendor: null, date: null, provider_used: 'error' };
}

// Bounded-concurrency pool. Preserves input order by index.
const receipts = new Array(files.length);
let nextIdx = 0;
async function worker() {
  while (nextIdx < files.length) {
    const i = nextIdx++;
    try {
      receipts[i] = await extractOne(files[i]);
    } catch (err) {
      // extractOne already swallows per-attempt errors, but defend against
      // anything bubbling up so a single failure can't reject the pool.
      console.error(`[extract-receipts] worker error for ${files[i]}: ${err.message}`);
      receipts[i] = { file: files[i], amount_cents: null, confidence: null, currency: null, vendor: null, date: null, provider_used: 'error' };
    }
    // Server matches this prefix to drive the progress bar. receipt-meta's
    // own `done:` line is captured by execFileAsync and never reaches us.
    console.error(`[extract-receipts] done: ${files[i]}`);
  }
}
await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

process.stdout.write(JSON.stringify(receipts));
