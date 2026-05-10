import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, readdirSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { writeAtomic } from './utils.mjs';

const RECEIPT_EXTS = new Set(['.pdf', '.jpg', '.jpeg', '.png']);
const STATUS_FOLDERS = new Set(['_matched', '_review', '_unmatched']);

export function findReceipts(rootPath) {
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
const PROJECT = process.env.AI_GEMINI_PROJECT || '';
const LOCATION = process.env.AI_GEMINI_LOCATION || 'europe-west1';
const MODEL = process.env.AI_GEMINI_MODEL || 'gemini-2.5-flash';

const NODE_BIN = process.env.NODE_BIN;
if (!NODE_BIN) {
  throw new Error('NODE_BIN is not configured (must point to Electron binary; set by electron/main.js)');
}
const NODE_ENV_EXTRA = { ELECTRON_RUN_AS_NODE: '1' };

/**
 * Spawn extract-receipts.mjs against a list of files using the given cache file.
 * Streams stderr to drive a progress emitter and returns the parsed metadata array.
 *
 * @param {object} opts
 * @param {string} opts.docsPath - period docs/ dir (used as scratch root for the file list)
 * @param {string[]} opts.files - absolute paths to receipt files
 * @param {string} opts.cachePath - JSON cache path passed via --cache
 * @param {string} opts.listFileName - filename for the per-file list (e.g. 'receipt-files.txt')
 * @param {string} opts.progressStep - SSE step name for progress events
 * @param {(event: object) => void} opts.emit
 * @param {boolean} [opts.forceReanalyze]
 * @param {string[]} opts.tempFiles - cleanup queue (mutated)
 */
export async function extractToCache({ docsPath, files, cachePath, listFileName, progressStep, emit, forceReanalyze = false, tempFiles }) {
  const listPath = join(docsPath, listFileName);
  writeAtomic(listPath, files.join('\n'));

  emit({ step: progressStep, current: 0, total: files.length });

  const extractArgs = [join(WORKER_BIN, 'extract-receipts.mjs'), listPath, '--cache', cachePath];
  if (forceReanalyze) extractArgs.push('--force');
  if (MODEL) extractArgs.push('--model', MODEL);
  if (PROJECT) extractArgs.push('--project', PROJECT);
  if (LOCATION) extractArgs.push('--location', LOCATION);

  const stdoutTmpPath = join(tmpdir(), `concilia-extract-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  tempFiles.push(stdoutTmpPath);
  const results = await new Promise((resolve, reject) => {
    const stdoutStream = createWriteStream(stdoutTmpPath);
    const proc = spawn(NODE_BIN, extractArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...NODE_ENV_EXTRA } });
    let stderr = '';
    let extractedCount = 0;
    let lineBuf = '';

    const MAX_STDERR = 5 * 1024 * 1024;
    proc.stdout.pipe(stdoutStream);
    proc.stderr.pipe(process.stderr, { end: false });
    proc.stderr.on('data', (d) => {
      if (stderr.length + d.length <= MAX_STDERR) stderr += d;
      lineBuf += d.toString();
      const newlineIdx = lineBuf.lastIndexOf('\n');
      if (newlineIdx === -1) return;
      const complete = lineBuf.slice(0, newlineIdx);
      lineBuf = lineBuf.slice(newlineIdx + 1);
      for (const line of complete.split('\n')) {
        const isDone = line.includes('[extract-receipts] done:') || line.includes('[extract-receipts] cache hit:');
        if (isDone) {
          extractedCount = Math.min(extractedCount + 1, files.length);
          emit({ step: progressStep, current: extractedCount, total: files.length });
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

  writeAtomic(cachePath, JSON.stringify(results, null, 2));
  return results;
}

/**
 * Run the extract-receipts → match → write-match-result pipeline.
 * Used by both the full reconcile flow and the standalone scan-receipts flow.
 *
 * @param {object} opts
 * @param {string} opts.docsPath - period docs/ directory
 * @param {string[]} opts.receiptFiles - absolute paths to receipt files
 * @param {(event: object) => void} opts.emit - SSE-style progress emitter
 * @param {boolean} [opts.forceReanalyze] - bypass cache when extracting
 * @param {string[]} opts.tempFiles - cleanup queue (mutated)
 * @returns {Promise<{ receipts: object[], matchResult: object, matchResultPath: string }>}
 */
export async function runExtractAndMatch({ docsPath, receiptFiles, emit, forceReanalyze = false, tempFiles }) {
  const transactionsPath = join(docsPath, 'transactions.json');
  if (!existsSync(transactionsPath)) {
    throw new Error('No prior transactions found for this period');
  }

  const receiptsJsonPath = join(docsPath, 'receipts.json');
  const receipts = await extractToCache({
    docsPath,
    files: receiptFiles,
    cachePath: receiptsJsonPath,
    listFileName: 'receipt-files.txt',
    progressStep: 'extracting',
    emit,
    forceReanalyze,
    tempFiles,
  });

  emit({ step: 'matching' });
  const rulesPath = process.env.RULES_PATH;
  const rulesExist = existsSync(rulesPath);
  if (rulesExist) {
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

  return { receipts, matchResult, matchResultPath };
}

/**
 * Walk the period's reimbursements/ folder and extract metadata for any files
 * found. Writes <docs>/reimbursements.json. No-op (writes empty array) when the
 * folder is missing or empty so the report endpoint can rely on a stable shape.
 *
 * Reimbursements are receipts paid personally on the company's VAT — they have
 * no matching bank transaction, so the matcher is bypassed entirely.
 *
 * @param {object} opts
 * @param {string} opts.periodPath - <RECEIPTS_BASE>/<year>/<month>
 * @param {string} opts.docsPath
 * @param {(event: object) => void} opts.emit
 * @param {boolean} [opts.forceReanalyze]
 * @param {string[]} opts.tempFiles
 * @returns {Promise<{ reimbursements: object[], reimbursementsPath: string }>}
 */
export async function runReimbursements({ periodPath, docsPath, emit, forceReanalyze = false, tempFiles }) {
  const reimbursementsPath = join(periodPath, 'reimbursements');
  const reimbursementsJsonPath = join(docsPath, 'reimbursements.json');
  const files = findReceipts(reimbursementsPath);

  emit({ step: 'reimbursements_found', count: files.length });

  if (files.length === 0) {
    // Keep the artifact in sync — drop a stale file if the folder has been emptied.
    if (existsSync(reimbursementsJsonPath)) {
      writeAtomic(reimbursementsJsonPath, JSON.stringify([], null, 2));
    }
    return { reimbursements: [], reimbursementsPath: reimbursementsJsonPath };
  }

  const reimbursements = await extractToCache({
    docsPath,
    files,
    cachePath: reimbursementsJsonPath,
    listFileName: 'reimbursement-files.txt',
    progressStep: 'extracting_reimbursements',
    emit,
    forceReanalyze,
    tempFiles,
  });
  return { reimbursements, reimbursementsPath: reimbursementsJsonPath };
}

/**
 * Build the summary stats emitted on `done` events.
 */
export function buildSummary(matchResult, totalReceipts) {
  const txs = matchResult.transactions;
  const matched = txs.filter((t) => t.status === 'MATCHED' && t.notes !== 'bank_fee').length;
  const bankFees = txs.filter((t) => t.notes === 'bank_fee').length;
  const review = txs.filter((t) => t.status === 'REVIEW').length;
  const unmatched = txs.filter((t) => t.status === 'UNMATCHED').length;
  const total = txs.length;
  const matchRate = total > 0 ? Math.round(((matched + bankFees) / total) * 100) : 0;
  return {
    totalTransactions: total,
    matched: matched + bankFees,
    review,
    unmatched,
    bankFees,
    totalReceipts,
    matchedReceipts: matchResult.receiptsByStatus.matched.length,
    reviewReceipts: matchResult.receiptsByStatus.review.length,
    unmatchedReceipts: matchResult.receiptsByStatus.unmatched.length,
    matchRate,
  };
}

/**
 * Run a full reconciliation.
 *
 * @param {object} opts
 * @param {{ path: string, bank: string }[]} opts.statements
 * @param {string} opts.year
 * @param {string} opts.month
 * @param {(event: object) => void} opts.emit
 * @param {string} [opts.language] - Excel report language ("en" | "pt"); defaults to "en"
 */
export async function reconcile({ statements, year, month, emit, forceReanalyze = false, language = 'en' }) {
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

  // Pass 3-4: extract + match (shared with /api/scan-receipts)
  const { receipts, matchResult, matchResultPath } = await runExtractAndMatch({
    docsPath,
    receiptFiles,
    emit,
    forceReanalyze,
    tempFiles,
  });

  // Pass 4b: extract reimbursements (independent of matcher; report-only)
  await runReimbursements({ periodPath: receiptMonthPath, docsPath, emit, forceReanalyze, tempFiles });

  // Pass 5: export report
  emit({ step: 'exporting' });
  const reportPath = join(docsPath, 'report.xlsx');
  const reimbursementsJsonPath = join(docsPath, 'reimbursements.json');
  const exportArgs = [join(WORKER_BIN, 'export-xlsx.mjs'), matchResultPath, reportPath, '--lang', language];
  if (existsSync(reimbursementsJsonPath)) exportArgs.push('--reimbursements', reimbursementsJsonPath);
  await execFileAsync(NODE_BIN, exportArgs, { timeout: 60000, env: { ...process.env, ...NODE_ENV_EXTRA } });

  // Files are NOT moved here — deferred to POST /api/review when user confirms
  const summary = buildSummary(matchResult, receipts.length);
  emit({ step: 'done', summary, reportUrl: `/report/${year}/${month}/report.xlsx?lang=${language}&ts=${Date.now()}` });
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
