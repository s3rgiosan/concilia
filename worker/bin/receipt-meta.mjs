#!/usr/bin/env node

/**
 * Extract metadata from a single receipt file using Google Gemini AI (Vertex AI).
 *
 * Usage: node receipt-meta.mjs <file-path> --sa-key PATH [--project ID] [--location REGION] [--model MODEL]
 *
 * Output: JSON { file, amount_cents, confidence, currency, vendor, date, provider_used }
 */

import { existsSync, readFileSync } from 'node:fs';
import { GeminiProvider, RECEIPT_PROMPT } from '../lib/gemini.mjs';
import { extractPdfText } from '../lib/pdf-text.mjs';
import { renderPdfPageToPng } from '../lib/pdf-render.mjs';

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
 * Detect garbage text output (broken font encoding produces strings like "ddddd dd").
 * Receipts always contain digits and varied characters; if neither is true, treat as unreadable.
 */
function isLikelyReadableText(text) {
  const stripped = text.replace(/\s+/g, '');
  if (stripped.length === 0) return false;
  if (!/\d/.test(stripped)) return false;
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
 * Prepare payload for Gemini from a file.
 * Returns { text } for PDFs with extractable text, or { imageBase64, mimeType } for images/scanned PDFs.
 */
async function preparePayload(filePath) {
  const ext = filePath.toLowerCase().split('.').pop();
  const isPdf = ext === 'pdf';

  if (isPdf) {
    let pdfText = '';
    try {
      pdfText = await extractPdfText(filePath);
    } catch (err) {
      console.error(`[receipt-meta] pdf text extraction failed: ${filePath} — ${err.message}`);
    }

    if (pdfText && pdfText.trim().length > 10 && isLikelyReadableText(pdfText)) {
      return { text: pdfText };
    }

    if (pdfText) {
      console.error(`[receipt-meta] text output unusable (${pdfText.trim().length} chars), converting to image: ${filePath}`);
    }
    try {
      return await renderPdfPageToPng(filePath, { dpi: 300, page: 1 });
    } catch (err) {
      console.error(`[receipt-meta] pdf render failed: ${filePath} — ${err.message}`);
      return null;
    }
  }

  // Image file
  const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
  const b64 = readFileSync(filePath).toString('base64');
  return { imageBase64: b64, mimeType: mimeMap[ext] || 'image/png' };
}

async function main() {
  const payload = await preparePayload(args.file);
  if (!payload) {
    const output = {
      file: args.file,
      amount_cents: null,
      confidence: null,
      currency: null,
      vendor: null,
      date: null,
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
    let imagePayload = null;
    try {
      imagePayload = await renderPdfPageToPng(args.file, { dpi: 300, page: 1 });
    } catch (err) {
      console.error(`[receipt-meta] pdf render failed: ${args.file} — ${err.message}`);
    }
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
