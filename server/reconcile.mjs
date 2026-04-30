import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { writeAtomic } from './utils.mjs';

const execFileAsync = promisify(execFile);

const WORKER_BIN = '/worker/bin';
const RECEIPTS_BASE = process.env.RECEIPTS_PATH || '/receipts';
const SA_KEY = process.env.AI_GEMINI_SA_KEY || '';
const PROJECT = process.env.AI_GEMINI_PROJECT || '';
const LOCATION = process.env.AI_GEMINI_LOCATION || 'europe-west1';
const MODEL = process.env.AI_GEMINI_MODEL || 'gemini-2.5-flash';

function spawnAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Command failed (exit ${code}): ${stderr || stdout}`));
    });
    proc.on('error', reject);
  });
}

/**
 * Run a full reconciliation.
 *
 * @param {object} opts
 * @param {{ path: string, bank: string }[]} opts.statements
 * @param {string} opts.year
 * @param {string} opts.month
 * @param {(event: object) => void} opts.emit
 */
export async function reconcile({ statements, year, month, emit, forceReanalyze = false }) {
  const receiptMonthPath = join(RECEIPTS_BASE, year, month);
  const receiptsPath = join(receiptMonthPath, 'receipts');
  const docsPath = join(receiptMonthPath, 'docs');

  mkdirSync(docsPath, { recursive: true });
  mkdirSync(receiptsPath, { recursive: true });

  const TIMEOUT_MS = 30 * 60 * 1000;
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Reconciliation timed out after 30 minutes')), TIMEOUT_MS);
  });

  const tempPdfPaths = [];

  async function run() {
  const transactionsPath = join(docsPath, 'transactions.json');

  // Pass 1: parse statements (skipped on re-run if transactions.json exists)
  if (statements.length > 0) {
    emit({ step: 'parsing', count: statements.length });
    const allTransactions = [];
    const seenIds = new Set();

    for (const { path: statementPath, bank } of statements) {
      const pdfPath = statementPath.endsWith('.pdf') ? statementPath : `${statementPath}.pdf`;
      if (pdfPath !== statementPath) {
        renameSync(statementPath, pdfPath);
        tempPdfPaths.push(pdfPath);
      } else {
        tempPdfPaths.push(statementPath);
      }

      const { stdout } = await execFileAsync(
        'node',
        [join(WORKER_BIN, 'parse-statement.mjs'), bank, pdfPath],
        { timeout: 60000 },
      );
      const txs = JSON.parse(stdout);
      for (const tx of txs) {
        if (!seenIds.has(tx.id)) {
          seenIds.add(tx.id);
          allTransactions.push(tx);
        }
      }
    }

    writeAtomic(transactionsPath, JSON.stringify(allTransactions, null, 2));
  } else {
    if (!existsSync(transactionsPath)) {
      throw new Error('No statements uploaded and no prior transactions found for this period');
    }
    emit({ step: 'parsing', count: 0 });
  }

  // Pass 2: find receipt files in receipts/ (exclude status subfolders in case of partial prior run)
  const { stdout: findOut } = await spawnAsync('find', [
    receiptsPath,
    '-not', '-path', join(receiptsPath, '_matched', '*'),
    '-not', '-path', join(receiptsPath, '_review', '*'),
    '-not', '-path', join(receiptsPath, '_unmatched', '*'),
    '-type', 'f',
    '(', '-iname', '*.pdf', '-o', '-iname', '*.jpg', '-o', '-iname', '*.jpeg', '-o', '-iname', '*.png', ')',
  ]);

  const receiptFiles = findOut.split('\n').map((f) => f.trim()).filter(Boolean);
  emit({ step: 'receipts_found', count: receiptFiles.length });

  const receiptListPath = join(docsPath, 'receipt-files.txt');
  writeAtomic(receiptListPath, receiptFiles.join('\n'));

  // Pass 3: extract receipt metadata (streaming stderr for per-file progress)
  emit({ step: 'extracting', current: 0, total: receiptFiles.length });

  const receiptsJsonPath = join(docsPath, 'receipts.json');
  const extractArgs = [join(WORKER_BIN, 'extract-receipts.mjs'), receiptListPath, '--sa-key', SA_KEY, '--cache', receiptsJsonPath];
  if (forceReanalyze) extractArgs.push('--force');
  if (MODEL) extractArgs.push('--model', MODEL);
  if (PROJECT) extractArgs.push('--project', PROJECT);
  if (LOCATION) extractArgs.push('--location', LOCATION);

  const receipts = await new Promise((resolve, reject) => {
    const proc = spawn('node', extractArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    let extractedCount = 0;

    const MAX_BUF = 5 * 1024 * 1024; // cap stdout/stderr at 5 MB each
    proc.stdout.on('data', (d) => {
      if (stdout.length + d.length <= MAX_BUF) stdout += d;
    });
    proc.stderr.on('data', (d) => {
      if (stderr.length + d.length <= MAX_BUF) stderr += d;
      // Count completed receipts from stderr progress lines
      const lines = d.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        if (line.includes('[gemini]') || line.includes('[receipt-meta]') || line.includes('[extract-receipts]')) {
          extractedCount = Math.min(extractedCount + 1, receiptFiles.length);
          emit({ step: 'extracting', current: extractedCount, total: receiptFiles.length });
        }
      }
    });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Receipt extraction failed: ${stderr}`));
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error(`Failed to parse extraction output: ${e.message}`)); }
    });
    proc.on('error', reject);
  });

  writeAtomic(receiptsJsonPath, JSON.stringify(receipts, null, 2));

  // Pass 4: match
  emit({ step: 'matching' });
  const rulesPath = join(RECEIPTS_BASE, 'match-rules.json');
  const rulesExist = existsSync(rulesPath);
  console.log(`[match] rules: ${rulesExist ? rulesPath : 'none'}`);
  if (rulesExist) {
    try {
      const loaded = JSON.parse(readFileSync(rulesPath, 'utf8'));
      console.log(`[match] ${loaded.length} rule(s):`, JSON.stringify(loaded));
    } catch { /* ignore parse errors */ }
  }
  const matchArgs = [join(WORKER_BIN, 'match.mjs'), transactionsPath, receiptsJsonPath];
  if (rulesExist) matchArgs.push(rulesPath);
  const { stdout: matchOut } = await execFileAsync('node', matchArgs, { timeout: 60000 });
  const matchResult = JSON.parse(matchOut);
  const matchResultPath = join(docsPath, 'match-result.json');
  writeAtomic(matchResultPath, JSON.stringify(matchResult, null, 2));

  // Pass 5: export report
  emit({ step: 'exporting' });
  const reportPath = join(docsPath, 'report.xlsx');
  await execFileAsync(
    'node',
    [join(WORKER_BIN, 'export-xlsx.mjs'), matchResultPath, reportPath],
    { timeout: 60000 },
  );

  // Files are NOT moved here — deferred to POST /api/review when user confirms

  // Build summary
  const txs = matchResult.transactions;
  const matched = txs.filter((t) => t.status === 'MATCHED' && t.notes !== 'bank_fee').length;
  const bankFees = txs.filter((t) => t.notes === 'bank_fee').length;
  const review = txs.filter((t) => t.status === 'REVIEW').length;
  const unmatched = txs.filter((t) => t.status === 'UNMATCHED').length;
  const total = txs.length;
  const matchRate = total > 0 ? Math.round(((matched + bankFees) / total) * 100) : 0;

  const summary = {
    totalTransactions: total,
    matched: matched + bankFees,
    review,
    unmatched,
    bankFees,
    totalReceipts: receipts.length,
    matchedReceipts: matchResult.receiptsByStatus.matched.length,
    reviewReceipts: matchResult.receiptsByStatus.review.length,
    unmatchedReceipts: matchResult.receiptsByStatus.unmatched.length,
    matchRate,
  };

  emit({ step: 'done', summary, reportUrl: `/report/${year}/${month}/report.xlsx` });
  } // end run()

  try {
    await Promise.race([run(), timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
    for (const p of tempPdfPaths) {
      if (existsSync(p)) try { unlinkSync(p); } catch { /* ignore */ }
    }
  }
}
