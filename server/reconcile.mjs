import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, readdirSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { writeAtomic } from './utils.mjs';

const RECEIPT_EXTS = new Set(['.pdf', '.jpg', '.jpeg', '.png']);
const STATUS_FOLDERS = new Set(['_matched', '_review', '_unmatched']);

function findReceipts(rootPath) {
  if (!existsSync(rootPath)) return [];
  const out = [];
  const stack = [rootPath];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        // Skip status folders only at the top level
        if (dir === rootPath && STATUS_FOLDERS.has(ent.name)) continue;
        stack.push(full);
      } else if (ent.isFile()) {
        const dotIdx = ent.name.lastIndexOf('.');
        const ext = dotIdx >= 0 ? ent.name.slice(dotIdx).toLowerCase() : '';
        if (RECEIPT_EXTS.has(ext)) out.push(full);
      }
    }
  }
  // Sort to make matching deterministic across filesystems / runs.
  out.sort();
  return out;
}

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_BIN = process.env.WORKER_DIR || join(__dirname, '..', 'worker', 'bin');
const RECEIPTS_BASE = process.env.RECEIPTS_PATH;
if (!RECEIPTS_BASE) throw new Error('RECEIPTS_PATH is not configured');
const SA_KEY = process.env.AI_GEMINI_SA_KEY || '';
const PROJECT = process.env.AI_GEMINI_PROJECT || '';
const LOCATION = process.env.AI_GEMINI_LOCATION || 'europe-west1';
const MODEL = process.env.AI_GEMINI_MODEL || 'gemini-2.5-flash';

const NODE_BIN = process.env.NODE_BIN || process.execPath;
const NODE_ENV_EXTRA = process.env.NODE_BIN ? { ELECTRON_RUN_AS_NODE: '1' } : {};

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
  const tempFiles = [];

  async function run() {
  const transactionsPath = join(docsPath, 'transactions.json');

  // Pass 1: parse statements (skipped on re-run if transactions.json exists)
  if (statements.length > 0) {
    emit({ step: 'parsing', count: statements.length });
    const allTransactions = [];
    const seenIds = new Set();

    for (const { path: statementPath, bank } of statements) {
      // Track the original tmpfile path BEFORE attempting rename so a rename
      // failure cannot leak the multer-created tmp file.
      tempPdfPaths.push(statementPath);
      const pdfPath = statementPath.endsWith('.pdf') ? statementPath : `${statementPath}.pdf`;
      if (pdfPath !== statementPath) {
        renameSync(statementPath, pdfPath);
        tempPdfPaths.push(pdfPath);
      }

      const { stdout } = await execFileAsync(
        NODE_BIN,
        [join(WORKER_BIN, 'parse-statement.mjs'), bank, pdfPath],
        { timeout: 60000, env: { ...process.env, ...NODE_ENV_EXTRA } },
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

  // Pass 2: find receipt files in receipts/ (excluding status subfolders)
  const receiptFiles = findReceipts(receiptsPath);
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

  const stdoutTmpPath = join(tmpdir(), `concilia-extract-${process.pid}-${Date.now()}.json`);
  tempFiles.push(stdoutTmpPath);
  const receipts = await new Promise((resolve, reject) => {
    const stdoutStream = createWriteStream(stdoutTmpPath);
    const proc = spawn(NODE_BIN, extractArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...NODE_ENV_EXTRA } });
    let stderr = '';
    let extractedCount = 0;
    let lineBuf = '';

    const MAX_STDERR = 5 * 1024 * 1024;
    proc.stdout.pipe(stdoutStream);
    // Forward stderr to the parent's stderr (server log) via pipe so
    // backpressure is handled by the kernel rather than a blocking write.
    proc.stderr.pipe(process.stderr, { end: false });
    proc.stderr.on('data', (d) => {
      if (stderr.length + d.length <= MAX_STDERR) stderr += d;
      // Buffer partial lines across chunks — `[receipt-meta] done:` markers
      // can be split across pipe chunks and would otherwise be missed.
      lineBuf += d.toString();
      const newlineIdx = lineBuf.lastIndexOf('\n');
      if (newlineIdx === -1) return;
      const complete = lineBuf.slice(0, newlineIdx);
      lineBuf = lineBuf.slice(newlineIdx + 1);
      for (const line of complete.split('\n')) {
        // `[extract-receipts] done: <file>` — one per processed receipt
        // `[extract-receipts] cache hit: <file>` — one per cached receipt
        const isDone = line.includes('[extract-receipts] done:') || line.includes('[extract-receipts] cache hit:');
        if (isDone) {
          extractedCount = Math.min(extractedCount + 1, receiptFiles.length);
          emit({ step: 'extracting', current: extractedCount, total: receiptFiles.length });
        }
      }
    });
    proc.on('close', (code) => {
      stdoutStream.end(() => {
        if (code !== 0) {
          try { unlinkSync(stdoutTmpPath); } catch { /* ignore */ }
          return reject(new Error(`Receipt extraction failed: ${stderr}`));
        }
        try {
          const stdout = readFileSync(stdoutTmpPath, 'utf8');
          unlinkSync(stdoutTmpPath);
          resolve(JSON.parse(stdout));
        } catch (e) {
          try { unlinkSync(stdoutTmpPath); } catch { /* ignore */ }
          reject(new Error(`Failed to parse extraction output: ${e.message}`));
        }
      });
    });
    proc.on('error', reject);
  });

  writeAtomic(receiptsJsonPath, JSON.stringify(receipts, null, 2));

  // Pass 4: match
  emit({ step: 'matching' });
  const rulesPath = process.env.RULES_PATH;
  const rulesExist = existsSync(rulesPath);
  if (rulesExist) {
    // Log the rule COUNT only; the rule contents are user-typed vendor
    // strings (PII-ish) and don't belong in server logs.
    try {
      const loaded = JSON.parse(readFileSync(rulesPath, 'utf8'));
      console.log(`[match] ${loaded.length} custom rule(s) loaded`);
    } catch { /* ignore parse errors */ }
  }
  const matchArgs = [join(WORKER_BIN, 'match.mjs'), transactionsPath, receiptsJsonPath];
  if (rulesExist) matchArgs.push(rulesPath);
  const { stdout: matchOut } = await execFileAsync(NODE_BIN, matchArgs, { timeout: 60000, env: { ...process.env, ...NODE_ENV_EXTRA } });
  const matchResult = JSON.parse(matchOut);
  const matchResultPath = join(docsPath, 'match-result.json');
  writeAtomic(matchResultPath, JSON.stringify(matchResult, null, 2));

  // Pass 5: export report
  emit({ step: 'exporting' });
  const reportPath = join(docsPath, 'report.xlsx');
  await execFileAsync(
    NODE_BIN,
    [join(WORKER_BIN, 'export-xlsx.mjs'), matchResultPath, reportPath],
    { timeout: 60000, env: { ...process.env, ...NODE_ENV_EXTRA } },
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
    for (const p of [...tempPdfPaths, ...tempFiles]) {
      if (existsSync(p)) try { unlinkSync(p); } catch { /* ignore */ }
    }
  }
}
