#!/usr/bin/env node

/**
 * Extract metadata from a single receipt file using Google Gemini AI (Vertex AI).
 *
 * Usage: node receipt-meta.mjs <file-path> --sa-key PATH [--project ID] [--location REGION] [--model MODEL]
 *
 * Output: JSON { file, amount_cents, confidence, currency, provider_used }
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { GeminiProvider, RECEIPT_PROMPT } from '../lib/gemini.mjs';

function parseArgs(argv) {
  const args = { file: null, saKey: null, project: null, location: null, model: null };
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
    } else if (!argv[i].startsWith('-')) {
      args.file = argv[i];
    }
    i++;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!args.file) {
  console.error('Usage: node receipt-meta.mjs <file-path> --sa-key PATH [--project ID] [--location REGION] [--model MODEL]');
  process.exit(1);
}

if (!existsSync(args.file)) {
  console.error(`File not found: "${args.file}"`);
  process.exit(1);
}

const saKeyPath = args.saKey || process.env.AI_GEMINI_SA_KEY;
if (!saKeyPath) {
  console.error('Error: --sa-key is required (or set AI_GEMINI_SA_KEY env var)');
  process.exit(1);
}

if (!existsSync(saKeyPath)) {
  console.error(`Service account key file not found: "${saKeyPath}"`);
  process.exit(1);
}

const serviceAccount = JSON.parse(readFileSync(saKeyPath, 'utf8'));
const project = args.project || process.env.AI_GEMINI_PROJECT || serviceAccount.project_id;
const location = args.location || process.env.AI_GEMINI_LOCATION || 'europe-west1';
const model = args.model || process.env.AI_GEMINI_MODEL;

const provider = new GeminiProvider({
  serviceAccount,
  project,
  location,
  model: model || undefined,
});

/**
 * Detect garbage pdftotext output (broken font encoding produces strings like "ddddd dd").
 * Receipts always contain digits and varied characters; if neither is true, treat as unreadable.
 */
function isLikelyReadableText(text) {
  const stripped = text.replace(/\s+/g, '');
  if (stripped.length === 0) return false;
  // Receipts have numbers
  if (!/\d/.test(stripped)) return false;
  // Single-character dominance check: if any one letter is >60% of letters, it's garbage
  const letters = stripped.replace(/[^a-zA-Z]/g, '').toLowerCase();
  if (letters.length > 50) {
    const counts = new Map();
    for (const c of letters) counts.set(c, (counts.get(c) ?? 0) + 1);
    const max = Math.max(...counts.values());
    if (max / letters.length > 0.6) return false;
  }
  return true;
}

/**
 * Render the first page of a PDF as a base64-encoded PNG image (300 DPI).
 * Returns null on failure.
 */
function renderPdfAsImage(filePath) {
  const tmpPrefix = `${tmpdir()}/rcpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpFile = `${tmpPrefix}-1.png`;
  try {
    execFileSync('pdftoppm', ['-png', '-r', '300', '-f', '1', '-l', '1', filePath, tmpPrefix], { timeout: 30000 });
  } catch (err) {
    console.error(`[receipt-meta] pdftoppm failed: ${filePath} — ${err.message}`);
    try { unlinkSync(tmpFile); } catch { /* may not exist */ }
    return null;
  }
  try {
    if (!existsSync(tmpFile)) return null;
    const imageB64 = readFileSync(tmpFile).toString('base64');
    return { imageBase64: imageB64, mimeType: 'image/png' };
  } finally {
    try { unlinkSync(tmpFile); } catch { /* already cleaned or never created */ }
  }
}

/**
 * Prepare payload for Gemini from a file.
 * Returns { text } for PDFs with extractable text, or { imageBase64, mimeType } for images/scanned PDFs.
 */
function preparePayload(filePath) {
  const ext = filePath.toLowerCase().split('.').pop();
  const isPdf = ext === 'pdf';

  if (isPdf) {
    let pdfText = '';
    try {
      // -layout preserves column structure so label/value pairs stay on the same line
      pdfText = execFileSync('pdftotext', ['-layout', filePath, '-'], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, timeout: 30000 });
    } catch { /* empty */ }

    if (pdfText && pdfText.trim().length > 10 && isLikelyReadableText(pdfText)) {
      return { text: pdfText };
    }

    // Text too short, empty, or garbage (broken font encoding) — convert to image
    if (pdfText) {
      console.error(`[receipt-meta] pdftotext output unusable (${pdfText.trim().length} chars), converting to image: ${filePath}`);
    }
    return renderPdfAsImage(filePath);
  }

  // Image file
  const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
  const b64 = readFileSync(filePath).toString('base64');
  return { imageBase64: b64, mimeType: mimeMap[ext] || 'image/png' };
}

async function main() {
  const payload = preparePayload(args.file);
  if (!payload) {
    const output = {
      file: args.file,
      amount_cents: null,
      confidence: null,
      currency: null,
      provider_used: 'gemini',
    };
    process.stdout.write(JSON.stringify(output));
    return;
  }

  let result = null;
  try {
    result = await provider.extract(RECEIPT_PROMPT, payload);
  } catch (err) {
    console.error(`[receipt-meta] Gemini extraction failed: ${args.file} — ${err.message}`);
  }

  // Vision fallback: text payload failed → re-render the PDF as an image and try again
  if (!result && payload?.text && args.file.toLowerCase().endsWith('.pdf')) {
    console.error(`[receipt-meta] text extraction failed, retrying with vision: ${args.file}`);
    const imagePayload = renderPdfAsImage(args.file);
    if (imagePayload) {
      try {
        result = await provider.extract(RECEIPT_PROMPT, imagePayload);
      } catch (err) {
        console.error(`[receipt-meta] Vision fallback also failed: ${args.file} — ${err.message}`);
      }
    }
  }

  const output = {
    file: args.file,
    amount_cents: result ? result.amount_cents : null,
    confidence: result ? result.confidence : null,
    currency: result ? result.currency : null,
    vendor: result ? result.vendor : null,
    date: result ? result.date : null,
    provider_used: 'gemini',
  };

  process.stdout.write(JSON.stringify(output));
  process.stderr.write(`[receipt-meta] done: ${args.file}\n`);
}

main().catch((err) => {
  console.error(`receipt-meta failed: ${err.message}`);
  process.exit(1);
});
