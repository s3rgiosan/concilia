import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { reconcile } from './reconcile.mjs';
import { writeAtomic } from './utils.mjs';
import { authMiddleware } from './middleware/auth.mjs';
import { errorHandler } from './middleware/errorHandler.mjs';
import { authRateLimiter, apiRateLimiter } from './middleware/rateLimiter.mjs';
import { cleanExpiredSessions } from './services/auth.mjs';
import authRouter from './routes/auth.mjs';

const execFileAsync = promisify(execFile);
const WORKER_BIN = '/worker/bin';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid PORT value: "${process.env.PORT}"`);
  process.exit(1);
}
const RECEIPTS_BASE = process.env.RECEIPTS_PATH || '/receipts';

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
      objectSrc: ["'self'", 'blob:'],
      frameAncestors: ["'self'"],
    },
  },
}));

app.use((req, _res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

app.use(cookieParser());
app.use(express.static(join(__dirname, 'public')));

const KNOWN_BANKS = new Set(['cgd']);

function resetPeriod(periodPath, docsPath) {
  const receiptsPath = join(periodPath, 'receipts');
  for (const folder of ['_matched', '_review', '_unmatched']) {
    const folderPath = join(receiptsPath, folder);
    if (!existsSync(folderPath)) continue;
    for (const f of readdirSync(folderPath)) {
      const src = join(folderPath, f);
      let dst = join(receiptsPath, f);
      if (existsSync(dst)) {
        const ext = f.includes('.') ? f.slice(f.lastIndexOf('.')) : '';
        const base = f.slice(0, f.length - ext.length);
        dst = join(receiptsPath, `${base}-restored${ext}`);
      }
      try { renameSync(src, dst); } catch (e) { console.warn('[reset]', e.message); }
    }
  }
  for (const f of ['receipts.json', 'match-result.json', '.applied']) {
    const p = join(docsPath, f);
    if (existsSync(p)) try { unlinkSync(p); } catch { /* ignore */ }
  }
}

// Global rate limit for all API traffic
app.use('/api', apiRateLimiter);

// Auth routes (extra strict rate limit on login/register)
app.use('/api/auth/login', authRateLimiter);
app.use('/api/auth/register', authRateLimiter);
app.use('/api/auth', express.json(), authRouter);

// All remaining /api/* routes require auth
app.use('/api', authMiddleware);

const RULES_PATH = join(RECEIPTS_BASE, 'match-rules.json');

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
}, (req, res) => {
  const { year, month } = req.body;

  if (!/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month)) {
    res.status(400).json({ error: 'Invalid year/month' });
    return;
  }
  const files = req.files;
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

  const periodPath = join(RECEIPTS_BASE, year, month);
  const docsPath = join(periodPath, 'docs');

  if (req.body.clearCache === 'true') {
    mkdirSync(docsPath, { recursive: true });
    resetPeriod(periodPath, docsPath);
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
      const relativePath = meta.file.startsWith(RECEIPTS_BASE)
        ? meta.file.slice(RECEIPTS_BASE.length).replace(/^\//, '')
        : meta.file.replace(/^\//, '');
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
  const periodPath = join(RECEIPTS_BASE, year, month);
  const docsPath = join(periodPath, 'docs');
  const matchResultPath = join(docsPath, 'match-result.json');
  const reportPath = join(docsPath, 'report.xlsx');

  if (!existsSync(matchResultPath)) {
    res.status(404).json({ error: 'No reconciliation data found for this period' });
    return;
  }

  try {
    const { transactions, unmatchedReceipts } = req.body;

    if (!Array.isArray(transactions) || !Array.isArray(unmatchedReceipts)) {
      res.status(400).json({ error: 'transactions and unmatchedReceipts must be arrays' });
      return;
    }

    function targetFolder(status) {
      if (status === 'MATCHED') return '_matched';
      if (status === 'REVIEW') return '_review';
      return '_unmatched';
    }

    const receiptsPath = join(periodPath, 'receipts');

    function isSafeReceiptPath(filePath) {
      if (!filePath || typeof filePath !== 'string') return false;
      const resolved = filePath.startsWith('/') ? filePath : join(periodPath, filePath);
      return resolved.startsWith(periodPath + '/');
    }

    for (const folder of ['_matched', '_review', '_unmatched']) {
      mkdirSync(join(receiptsPath, folder), { recursive: true });
    }

    const assigned = new Set();

    const updatedTransactions = transactions.map((tx) => {
      const folder = targetFolder(tx.status);
      const updatedMeta = (tx.receipt_meta || []).map((m) => {
        if (!isSafeReceiptPath(m.file)) {
          console.warn('[apply] rejected unsafe path:', m.file);
          return m;
        }
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

    const updatedUnmatched = unmatchedReceipts.map((m) => {
      if (!isSafeReceiptPath(m.file)) {
        console.warn('[apply] rejected unsafe unmatched path:', m.file);
        return m;
      }
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
    writeAtomic(matchResultPath, JSON.stringify(
      { transactions: cleanTransactions, receiptsByStatus, unmatchedReceipts: cleanUnmatched },
      null, 2,
    ));

    await execFileAsync('node', [join(WORKER_BIN, 'export-xlsx.mjs'), matchResultPath, reportPath], { timeout: 60000 });

    writeFileSync(join(docsPath, '.applied'), new Date().toISOString());

    res.json({ reportUrl: `/report/${year}/${month}/report.xlsx` });
  } catch (err) {
    console.error('[review POST]', err);
    res.status(500).json({ error: err.message });
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
  if (!absFile.startsWith(periodPath + '/')) {
    res.status(400).json({ error: 'file outside period scope' });
    return;
  }
  if (!existsSync(absFile)) {
    res.status(404).json({ error: 'file not found' });
    return;
  }
  if (rescanLocks.has(absFile)) {
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

  rescanLocks.add(absFile);
  try {
    const cmdArgs = [join(WORKER_BIN, 'receipt-meta.mjs'), absFile, '--sa-key', SA_KEY, '--location', LOCATION, '--model', MODEL];
    if (PROJECT) cmdArgs.push('--project', PROJECT);
    const { stdout } = await execFileAsync('node', cmdArgs, { timeout: 180000 });
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

    const relativePath = absFile.startsWith(RECEIPTS_BASE)
      ? absFile.slice(RECEIPTS_BASE.length).replace(/^\//, '')
      : absFile.replace(/^\//, '');
    res.json({ ...newMeta, receiptUrl: `/api/receipt/${relativePath}` });
  } catch (err) {
    console.error('[rescan-receipt]', err);
    res.status(500).json({ error: err.message });
  } finally {
    rescanLocks.delete(absFile);
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
  if (rel.startsWith('docs/') || rel === 'docs') {
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
  res.setHeader('Content-Type', contentType);
  res.sendFile(filePath);
});

// Report download also requires auth
app.get('/report/:year/:month/report.xlsx', authMiddleware, (req, res) => {
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

// SPA fallback — only for non-API routes
app.get(/^(?!\/api\/).*$/, (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.use(errorHandler);

// Clean expired sessions on startup
cleanExpiredSessions();

app.listen(PORT, () => {
  console.log(`Concilia listening on http://0.0.0.0:${PORT}`);
});
