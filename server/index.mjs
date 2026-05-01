import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import { sep as PATH_SEP } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { reconcile } from './reconcile.mjs';
import { writeAtomic } from './utils.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_BIN = process.env.WORKER_DIR || join(__dirname, '..', 'worker', 'bin');
const NODE_BIN = process.env.NODE_BIN || process.execPath;
const NODE_ENV_EXTRA = process.env.NODE_BIN ? { ELECTRON_RUN_AS_NODE: '1' } : {};

const PORT = parseInt(process.env.PORT || '3000', 10);
if (isNaN(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`Invalid PORT value: "${process.env.PORT}"`);
  process.exit(1);
}
const RECEIPTS_BASE = process.env.RECEIPTS_PATH;
if (!RECEIPTS_BASE) {
  console.error('RECEIPTS_PATH is not configured');
  process.exit(1);
}

const upload = multer({
  dest: tmpdir(),
  limits: { fileSize: 50 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname);
    cb(ok ? null : new Error('Only PDF files are accepted'), ok);
  },
});
const app = express();

process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'self'"],
      frameSrc: ["'self'"],
      frameAncestors: ["'self'"],
    },
  },
  hsts: false,
}));

// Skip noisy poll routes (busy/status) from request log.
const QUIET_PATH_RE = /^\/api\/(busy|status\/)/;
app.use((req, _res, next) => {
  if (!QUIET_PATH_RE.test(req.url)) console.log(`${req.method} ${req.url}`);
  next();
});

const PUBLIC_DIR = join(__dirname, 'public');
const INDEX_HTML = join(PUBLIC_DIR, 'index.html');
if (!existsSync(INDEX_HTML)) {
  console.error(`[server] client bundle missing at ${INDEX_HTML}. Run \`npm run build:client\` first.`);
  process.exit(1);
}
app.use(express.static(PUBLIC_DIR));

const KNOWN_BANKS = new Set(['cgd']);
const reconcileLocks = new Set();

// Path-traversal-safe sandbox check. `dirPath` MUST be a directory (else
// returns false). `target` is treated as already-resolved (caller resolves
// symlinks before calling).
function isInsideDir(target, dirPath) {
  try { if (!statSync(dirPath).isDirectory()) return false; } catch { return false; }
  return target === dirPath || target.startsWith(dirPath + PATH_SEP);
}

async function resetPeriod(periodPath, docsPath) {
  const receiptsPath = join(periodPath, 'receipts');
  let workCount = 0;
  for (const folder of ['_matched', '_review', '_unmatched']) {
    const folderPath = join(receiptsPath, folder);
    if (!existsSync(folderPath)) continue;
    for (const f of readdirSync(folderPath)) {
      // Yield to the event loop every 50 files so /api/busy and other
      // requests aren't starved during a large reset.
      if (++workCount % 50 === 0) await new Promise((r) => setImmediate(r));
      const src = join(folderPath, f);
      let dst = join(receiptsPath, f);
      if (existsSync(dst)) {
        const ext = f.includes('.') ? f.slice(f.lastIndexOf('.')) : '';
        const base = f.slice(0, f.length - ext.length);
        let n = 1;
        const MAX_TRIES = 10000;
        do {
          dst = join(receiptsPath, n === 1 ? `${base}-restored${ext}` : `${base}-restored-${n}${ext}`);
          n++;
        } while (existsSync(dst) && n <= MAX_TRIES);
        if (existsSync(dst)) {
          console.warn('[reset] could not find a free name for', f);
          continue;
        }
      }
      try { renameSync(src, dst); } catch (e) { console.warn('[reset]', e.message); }
    }
  }
  for (const f of ['receipts.json', 'match-result.json', '.applied']) {
    const p = join(docsPath, f);
    if (existsSync(p)) try { unlinkSync(p); } catch { /* ignore */ }
  }
}

const RULES_PATH = process.env.RULES_PATH;
if (!RULES_PATH) {
  console.error('RULES_PATH is not configured');
  process.exit(1);
}

// GET /api/rules
app.get('/api/rules', (_req, res) => {
  try {
    const rules = existsSync(RULES_PATH) ? JSON.parse(readFileSync(RULES_PATH, 'utf8')) : [];
    res.json(rules);
  } catch (err) {
    console.error('[rules GET]', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/rules — replace full rules array
app.put('/api/rules', express.json(), (req, res) => {
  const rules = req.body;
  if (!Array.isArray(rules)) {
    res.status(400).json({ error: 'Body must be an array' });
    return;
  }
  for (const rule of rules) {
    if (typeof rule.receiptVendor !== 'string' || !rule.receiptVendor.trim() ||
        typeof rule.transactionDescription !== 'string' || !rule.transactionDescription.trim()) {
      res.status(400).json({ error: 'Each rule must have non-empty receiptVendor and transactionDescription' });
      return;
    }
  }
  try {
    writeAtomic(RULES_PATH, JSON.stringify(rules, null, 2));
    res.json({ ok: true });
  } catch (err) {
    console.error('[rules PUT]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/busy — true if any reconcile or rescan in flight (used by Electron
// main to block server-restart while work is running).
app.get('/api/busy', (_req, res) => {
  res.json({ busy: reconcileLocks.size > 0 || rescanLocks.size > 0 });
});

// GET /api/status/:year/:month
app.get('/api/status/:year/:month', (req, res) => {
  const { year, month } = req.params;
  if (!/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month)) {
    res.status(400).json({ error: 'Invalid year/month' });
    return;
  }
  const docsPath = join(RECEIPTS_BASE, year, month, 'docs');
  const exists = existsSync(join(docsPath, 'match-result.json'));
  const applied = existsSync(join(docsPath, '.applied'));
  res.json({ exists, applied });
});

// GET /api/draft/:year/:month — pending in-progress review changes (Accept/
// Reject/Assign decisions the user hasn't applied yet). Returns the persisted
// changes map keyed by transaction id, or {} when none.
app.get('/api/draft/:year/:month', (req, res) => {
  const { year, month } = req.params;
  if (!/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month)) {
    res.status(400).json({ error: 'Invalid year/month' });
    return;
  }
  const draftPath = join(RECEIPTS_BASE, year, month, 'docs', 'review-draft.json');
  if (!existsSync(draftPath)) { res.json({}); return; }
  try {
    const draft = JSON.parse(readFileSync(draftPath, 'utf8'));
    res.json(draft);
  } catch (err) {
    console.error('[draft GET]', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/draft/:year/:month — replace draft with the given object
app.put('/api/draft/:year/:month', express.json({ limit: '10mb' }), (req, res) => {
  const { year, month } = req.params;
  if (!/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month)) {
    res.status(400).json({ error: 'Invalid year/month' });
    return;
  }
  if (!req.body || typeof req.body !== 'object') {
    res.status(400).json({ error: 'Body must be an object' });
    return;
  }
  const docsPath = join(RECEIPTS_BASE, year, month, 'docs');
  if (!existsSync(docsPath)) mkdirSync(docsPath, { recursive: true });
  try {
    writeAtomic(join(docsPath, 'review-draft.json'), JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (err) {
    console.error('[draft PUT]', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/draft/:year/:month
app.delete('/api/draft/:year/:month', (req, res) => {
  const { year, month } = req.params;
  if (!/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month)) {
    res.status(400).json({ error: 'Invalid year/month' });
    return;
  }
  const draftPath = join(RECEIPTS_BASE, year, month, 'docs', 'review-draft.json');
  if (existsSync(draftPath)) try { unlinkSync(draftPath); } catch { /* ignore */ }
  res.json({ ok: true });
});

// POST /api/reconcile — multipart: statements[] (PDFs), banks[] (strings), year, month
// Response: SSE stream
app.post('/api/reconcile', (req, res, next) => {
  upload.array('statements')(req, res, (err) => {
    if (err) {
      console.error('[multer]', err);
      res.status(400).json({ error: err.message });
      return;
    }
    next();
  });
}, async (req, res) => {
  const { year, month } = req.body;

  if (!/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month)) {
    res.status(400).json({ error: 'Invalid year/month' });
    return;
  }
  const files = req.files || [];
  const banks = [].concat(req.body.banks || []);

  console.log(`[reconcile] year=${year} month=${month} files=${files?.length} banks=${JSON.stringify(banks)}`);

  const isRerun = req.body.clearCache === 'true';
  if (!year || !month || (!isRerun && (!files || files.length === 0))) {
    res.status(400).json({ error: 'year, month, and at least one statement are required' });
    return;
  }

  const invalidBank = banks.find((b) => !KNOWN_BANKS.has(b));
  if (invalidBank) {
    res.status(400).json({ error: `Unknown bank: ${invalidBank}` });
    return;
  }

  if (!process.env.AI_GEMINI_SA_KEY) {
    res.status(500).json({ error: 'AI_GEMINI_SA_KEY is not configured' });
    return;
  }

  const periodKey = `${year}-${month}`;
  if (reconcileLocks.has(periodKey)) {
    res.status(409).json({ error: 'Reconciliation already in progress for this period' });
    return;
  }
  reconcileLocks.add(periodKey);

  const periodPath = join(RECEIPTS_BASE, year, month);
  const docsPath = join(periodPath, 'docs');

  if (req.body.clearCache === 'true') {
    mkdirSync(docsPath, { recursive: true });
    await resetPeriod(periodPath, docsPath);
  }

  const statements = files.map((f, i) => ({
    path: f.path,
    bank: banks[i] || 'cgd',
  }));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.socket?.setNoDelay(true);
  res.flushHeaders();

  function emit(event) {
    console.log('[sse]', JSON.stringify(event));
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const forceReanalyze = req.body.clearCache === 'true';
  reconcile({ statements, year, month, emit, forceReanalyze })
    .catch((err) => {
      console.error('[reconcile error]', err);
      emit({ step: 'error', message: err.message });
    })
    .finally(() => {
      reconcileLocks.delete(periodKey);
      res.end();
    });
});

// GET /api/review/:year/:month
app.get('/api/review/:year/:month', (req, res) => {
  const { year, month } = req.params;
  if (!/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month)) {
    res.status(400).json({ error: 'Invalid year/month' });
    return;
  }
  const matchResultPath = join(RECEIPTS_BASE, year, month, 'docs', 'match-result.json');
  if (!existsSync(matchResultPath)) {
    res.status(404).json({ error: 'No reconciliation data found for this period' });
    return;
  }
  try {
    const matchResult = JSON.parse(readFileSync(matchResultPath, 'utf8'));

    function enrichMeta(meta) {
      const stripped = meta.file.startsWith(RECEIPTS_BASE)
        ? meta.file.slice(RECEIPTS_BASE.length).replace(/^\//, '')
        : meta.file.replace(/^\//, '');
      // Look for the FIRST /YYYY/MM/ segment within the relative portion
      const m = ('/' + stripped).match(/\/(\d{4})\/(0[1-9]|1[0-2])\/(.+)$/);
      const relativePath = m ? `${m[1]}/${m[2]}/${m[3]}` : stripped;
      return { ...meta, receiptUrl: `/api/receipt/${relativePath}` };
    }

    const transactions = matchResult.transactions.map((tx) => ({
      ...tx,
      receipt_meta: (tx.receipt_meta || []).map(enrichMeta),
    }));

    const unmatchedReceipts = (matchResult.unmatchedReceipts || []).map(enrichMeta);

    res.json({ transactions, unmatchedReceipts });
  } catch (err) {
    console.error('[review GET]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/review/:year/:month — apply manual corrections, move files, re-export
app.post('/api/review/:year/:month', express.json({ limit: '10mb' }), async (req, res) => {
  const { year, month } = req.params;
  if (!/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month)) {
    res.status(400).json({ error: 'Invalid year/month' });
    return;
  }
  const { transactions, unmatchedReceipts } = req.body;
  if (!Array.isArray(transactions) || !Array.isArray(unmatchedReceipts)) {
    res.status(400).json({ error: 'transactions and unmatchedReceipts must be arrays' });
    return;
  }
  const periodKey = `${year}-${month}`;
  if (reconcileLocks.has(periodKey)) {
    res.status(409).json({ error: 'Reconciliation in progress for this period' });
    return;
  }
  const periodPath = join(RECEIPTS_BASE, year, month);
  const docsPath = join(periodPath, 'docs');
  const matchResultPath = join(docsPath, 'match-result.json');
  const reportPath = join(docsPath, 'report.xlsx');
  if (!existsSync(matchResultPath)) {
    res.status(404).json({ error: 'No reconciliation data found for this period' });
    return;
  }
  reconcileLocks.add(periodKey);

  try {

    function targetFolder(status) {
      if (status === 'MATCHED') return '_matched';
      if (status === 'REVIEW') return '_review';
      return '_unmatched';
    }

    const receiptsPath = join(periodPath, 'receipts');

    function isSafeReceiptPath(filePath) {
      if (!filePath || typeof filePath !== 'string') return false;
      const resolved = filePath.startsWith('/') ? filePath : join(periodPath, filePath);
      let real;
      try { real = existsSync(resolved) ? realpathSync(resolved) : resolved; }
      catch { return false; }
      const realPeriod = (() => { try { return realpathSync(periodPath); } catch { return periodPath; } })();
      return isInsideDir(real, realPeriod);
    }

    for (const folder of ['_matched', '_review', '_unmatched']) {
      mkdirSync(join(receiptsPath, folder), { recursive: true });
    }

    const assigned = new Set();

    const updatedTransactions = transactions.map((tx) => {
      const folder = targetFolder(tx.status);
      const updatedMeta = (tx.receipt_meta || [])
        .filter((m) => {
          if (isSafeReceiptPath(m.file)) return true;
          console.warn('[apply] dropping unsafe path:', m.file);
          return false;
        })
        .map((m) => {
          const base = basename(m.file);
          const newPath = join(receiptsPath, folder, base);
          if (m.file !== newPath && existsSync(m.file) && !assigned.has(base)) {
            assigned.add(base);
            try { renameSync(m.file, newPath); } catch (e) { console.warn('[apply move]', e.message); }
          }
          return { ...m, file: newPath };
        });
      const updatedFiles = updatedMeta.map((m) => m.file);
      return { ...tx, receipt_meta: updatedMeta, receipt_files: updatedFiles };
    });

    const updatedUnmatched = unmatchedReceipts
      .filter((m) => {
        if (isSafeReceiptPath(m.file)) return true;
        console.warn('[apply] dropping unsafe unmatched path:', m.file);
        return false;
      })
      .map((m) => {
        const base = basename(m.file);
        const newPath = join(receiptsPath, '_unmatched', base);
        if (m.file !== newPath && existsSync(m.file) && !assigned.has(base)) {
          assigned.add(base);
          try { renameSync(m.file, newPath); } catch (e) { console.warn('[apply move unmatched]', e.message); }
        }
        return { ...m, file: newPath };
      });

    const receiptsByStatus = { matched: [], review: [], unmatched: [] };
    for (const tx of updatedTransactions) {
      const key = tx.status === 'MATCHED' ? 'matched' : tx.status === 'REVIEW' ? 'review' : 'unmatched';
      for (const f of (tx.receipt_files || [])) receiptsByStatus[key].push(f);
    }
    for (const m of updatedUnmatched) receiptsByStatus.unmatched.push(m.file);

    const cleanTransactions = updatedTransactions.map((tx) => ({
      ...tx,
      receipt_meta: (tx.receipt_meta || []).map(({ receiptUrl: _url, ...m }) => m),
    }));
    const cleanUnmatched = updatedUnmatched.map(({ receiptUrl: _url, ...m }) => m);

    // Write to temp paths first; only rename over the canonical paths once
    // BOTH the JSON and the XLSX have been generated successfully. Otherwise
    // a failed xlsx export would leave the on-disk JSON updated but the
    // report stale or absent.
    const matchResultTmp = `${matchResultPath}.tmp`;
    const reportTmp = `${reportPath}.tmp`;
    writeAtomic(matchResultTmp, JSON.stringify(
      { transactions: cleanTransactions, receiptsByStatus, unmatchedReceipts: cleanUnmatched },
      null, 2,
    ));
    try {
      await execFileAsync(NODE_BIN, [join(WORKER_BIN, 'export-xlsx.mjs'), matchResultTmp, reportTmp], { timeout: 60000, env: { ...process.env, ...NODE_ENV_EXTRA } });
    } catch (err) {
      try { unlinkSync(matchResultTmp); } catch { /* ignore */ }
      try { unlinkSync(reportTmp); } catch { /* ignore */ }
      throw err;
    }
    renameSync(matchResultTmp, matchResultPath);
    renameSync(reportTmp, reportPath);

    writeFileSync(join(docsPath, '.applied'), new Date().toISOString());

    // Clear in-progress draft now that the user-confirmed state is persisted.
    const draftPath = join(docsPath, 'review-draft.json');
    if (existsSync(draftPath)) try { unlinkSync(draftPath); } catch { /* ignore */ }

    res.json({ reportUrl: `/report/${year}/${month}/report.xlsx` });
  } catch (err) {
    console.error('[review POST]', err);
    res.status(500).json({ error: err.message });
  } finally {
    reconcileLocks.delete(periodKey);
  }
});

// POST /api/rescan-receipt/:year/:month — re-run Gemini extraction on a single receipt
const rescanLocks = new Set();
app.post('/api/rescan-receipt/:year/:month', express.json(), async (req, res) => {
  const { year, month } = req.params;
  if (!/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month)) {
    res.status(400).json({ error: 'Invalid year/month' });
    return;
  }
  const { file } = req.body || {};
  if (!file || typeof file !== 'string') {
    res.status(400).json({ error: 'file is required' });
    return;
  }
  const periodPath = join(RECEIPTS_BASE, year, month);
  const docsPath = join(periodPath, 'docs');
  const receiptsJsonPath = join(docsPath, 'receipts.json');
  const matchResultPath = join(docsPath, 'match-result.json');

  const absFile = file.startsWith('/') ? file : join(periodPath, file);
  if (!existsSync(absFile)) {
    res.status(404).json({ error: 'file not found' });
    return;
  }
  // Resolve symlinks before sandbox check so a symlink inside `periodPath`
  // pointing outside cannot escape.
  let realFile;
  try { realFile = realpathSync(absFile); }
  catch { res.status(400).json({ error: 'file resolution failed' }); return; }
  let realPeriod;
  try { realPeriod = realpathSync(periodPath); }
  catch { realPeriod = periodPath; }
  if (!isInsideDir(realFile, realPeriod)) {
    res.status(400).json({ error: 'file outside period scope' });
    return;
  }
  if (rescanLocks.has(realFile)) {
    res.status(409).json({ error: 'rescan already in progress for this file' });
    return;
  }

  const SA_KEY = process.env.AI_GEMINI_SA_KEY || '';
  const PROJECT = process.env.AI_GEMINI_PROJECT || '';
  const LOCATION = process.env.AI_GEMINI_LOCATION || 'europe-west1';
  const MODEL = process.env.AI_GEMINI_MODEL || 'gemini-2.5-flash';
  if (!SA_KEY) {
    res.status(500).json({ error: 'AI_GEMINI_SA_KEY not configured' });
    return;
  }

  rescanLocks.add(realFile);
  try {
    const cmdArgs = [join(WORKER_BIN, 'receipt-meta.mjs'), absFile, '--sa-key', SA_KEY, '--location', LOCATION, '--model', MODEL];
    if (PROJECT) cmdArgs.push('--project', PROJECT);
    const { stdout } = await execFileAsync(NODE_BIN, cmdArgs, { timeout: 180000, env: { ...process.env, ...NODE_ENV_EXTRA } });
    const newMeta = JSON.parse(stdout);

    if (existsSync(receiptsJsonPath)) {
      const arr = JSON.parse(readFileSync(receiptsJsonPath, 'utf8'));
      const idx = arr.findIndex((r) => r.file === absFile);
      if (idx >= 0) arr[idx] = newMeta; else arr.push(newMeta);
      writeAtomic(receiptsJsonPath, JSON.stringify(arr, null, 2));
    }

    if (existsSync(matchResultPath)) {
      const mr = JSON.parse(readFileSync(matchResultPath, 'utf8'));
      const patch = (m) => m.file === absFile ? newMeta : m;
      mr.transactions = (mr.transactions || []).map((tx) => ({
        ...tx,
        receipt_meta: (tx.receipt_meta || []).map(patch),
      }));
      mr.unmatchedReceipts = (mr.unmatchedReceipts || []).map(patch);
      writeAtomic(matchResultPath, JSON.stringify(mr, null, 2));
    }

    const stripped = absFile.startsWith(RECEIPTS_BASE)
      ? absFile.slice(RECEIPTS_BASE.length).replace(/^\//, '')
      : absFile.replace(/^\//, '');
    const m = ('/' + stripped).match(/\/(\d{4})\/(0[1-9]|1[0-2])\/(.+)$/);
    const relativePath = m ? `${m[1]}/${m[2]}/${m[3]}` : stripped;
    res.json({ ...newMeta, receiptUrl: `/api/receipt/${relativePath}` });
  } catch (err) {
    console.error('[rescan-receipt]', err);
    res.status(500).json({ error: err.message });
  } finally {
    rescanLocks.delete(realFile);
  }
});

// GET /api/receipt/:year/:month/* — serve receipt files (auth already applied via /api/* middleware)
app.get('/api/receipt/:year/:month/*', (req, res) => {
  const { year, month } = req.params;
  if (!/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month)) {
    res.status(400).send('Invalid year/month');
    return;
  }
  const relativePath = req.params[0];
  if (!relativePath) {
    res.status(400).send('Missing file path');
    return;
  }
  const periodBase = join(RECEIPTS_BASE, year, month);
  const filePath = join(periodBase, relativePath);

  if (!filePath.startsWith(periodBase + '/')) {
    res.status(400).send('Invalid path');
    return;
  }
  const rel = filePath.slice(periodBase.length + 1);
  // Only files under the receipts/ subtree may be served
  if (!rel.startsWith('receipts/')) {
    res.status(403).send('Forbidden');
    return;
  }

  const ext = filePath.split('.').pop()?.toLowerCase();
  const ALLOWED_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
  const contentType = ALLOWED_TYPES[ext ?? ''];
  if (!contentType) {
    res.status(400).send('Unsupported file type');
    return;
  }

  if (!existsSync(filePath)) {
    res.status(404).send('File not found');
    return;
  }
  // Resolve symlinks before serving so a symlink inside receipts/ pointing
  // outside the period sandbox cannot escape.
  let realFile;
  try { realFile = realpathSync(filePath); } catch { res.status(400).send('Invalid path'); return; }
  let realBase;
  try { realBase = realpathSync(periodBase); } catch { realBase = periodBase; }
  if (!isInsideDir(realFile, realBase)) {
    res.status(403).send('Forbidden');
    return;
  }
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.sendFile(realFile);
});

app.get('/report/:year/:month/report.xlsx', (req, res) => {
  const { year, month } = req.params;
  if (!/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month)) {
    res.status(400).send('Invalid year/month');
    return;
  }
  const filePath = join(RECEIPTS_BASE, year, month, 'docs', 'report.xlsx');
  if (!existsSync(filePath)) {
    res.status(404).send('Report not found');
    return;
  }
  res.download(filePath, `${year}-${month}.xlsx`);
});

// SPA fallback — only for non-API, non-report routes WITHOUT a file extension.
// Requests like /favicon.ico that miss the static handler should 404, not
// return index.html with the wrong content-type (which confuses browser cache).
app.get(/^(?!\/api\/|\/report\/).*$/, (req, res) => {
  if (/\.[a-zA-Z0-9]{1,8}$/.test(req.path)) {
    res.status(404).send('Not found');
    return;
  }
  res.sendFile(INDEX_HTML);
});

const HOST = process.env.HOST || '127.0.0.1';
const server = app.listen(PORT, HOST, () => {
  const actualPort = server.address().port;
  console.log(`Concilia listening on http://${HOST}:${actualPort}`);
  if (process.send) process.send({ type: 'ready', port: actualPort });
});
