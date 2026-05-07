const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { writeFileSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');

const scriptPath = join(__dirname, '..', '..', 'worker', 'bin', 'extract-receipts.mjs');

describe('extract-receipts CLI', () => {
  it('exits with error when no arguments given', () => {
    assert.throws(
      () => execFileSync('node', [scriptPath], { encoding: 'utf8', stdio: 'pipe' }),
      (err) => {
        assert.match(err.stderr, /Usage:/);
        assert.equal(err.status, 1);
        return true;
      },
    );
  });

  it('exits with error when AI_GEMINI_SA_KEY env var is not set', () => {
    const tmpFile = '/tmp/test-extract-receipts-list.txt';
    writeFileSync(tmpFile, '/some/receipt.pdf\n');
    try {
      const env = { ...process.env };
      delete env.AI_GEMINI_SA_KEY;
      assert.throws(
        () => execFileSync('node', [scriptPath, tmpFile], { encoding: 'utf8', stdio: 'pipe', env }),
        (err) => {
          assert.match(err.stderr, /AI_GEMINI_SA_KEY env var is required/i);
          assert.equal(err.status, 1);
          return true;
        },
      );
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('outputs empty JSON array for empty file list', () => {
    const tmpList = '/tmp/test-extract-receipts-empty.txt';
    writeFileSync(tmpList, '');
    try {
      const out = execFileSync('node', [scriptPath, tmpList], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, AI_GEMINI_SA_KEY: '/tmp/fake.json' },
      });
      assert.deepEqual(JSON.parse(out), []);
    } finally {
      unlinkSync(tmpList);
    }
  });

  it('returns cached entry for confidence:high receipts without calling Gemini', () => {
    const tmpList = '/tmp/test-extract-receipts-cached-list.txt';
    const tmpCache = '/tmp/test-extract-receipts-cache.json';
    const cachedEntry = {
      file: '/receipts/2025/01/amazon.pdf',
      amount_cents: 4599,
      confidence: 'high',
      currency: 'EUR',
      vendor: 'Amazon',
      provider_used: 'gemini',
    };
    writeFileSync(tmpList, '/receipts/2025/01/amazon.pdf\n');
    writeFileSync(tmpCache, JSON.stringify([cachedEntry]));
    try {
      // SA key points to nonexistent file — proves Gemini is never called.
      const out = execFileSync(
        'node',
        [scriptPath, tmpList, '--cache', tmpCache],
        { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, AI_GEMINI_SA_KEY: '/tmp/nonexistent-key.json' } },
      );
      assert.deepEqual(JSON.parse(out), [cachedEntry]);
    } finally {
      unlinkSync(tmpList);
      unlinkSync(tmpCache);
    }
  });

  it('ignores cache and calls Gemini when --force is passed', () => {
    const tmpList = '/tmp/test-extract-receipts-force-list.txt';
    const tmpCache = '/tmp/test-extract-receipts-force-cache.json';
    const cachedEntry = {
      file: '/receipts/2025/01/amazon.pdf',
      amount_cents: 4599,
      confidence: 'high',
      currency: 'EUR',
      vendor: 'Amazon',
      provider_used: 'gemini',
    };
    writeFileSync(tmpList, '/receipts/2025/01/amazon.pdf\n');
    writeFileSync(tmpCache, JSON.stringify([cachedEntry]));
    try {
      // With --force, cache is bypassed → receipt-meta.mjs is called → file not found → error entry
      const result = spawnSync(
        'node',
        [scriptPath, tmpList, '--cache', tmpCache, '--force'],
        { encoding: 'utf8', env: { ...process.env, AI_GEMINI_SA_KEY: '/tmp/nonexistent-key.json' } },
      );
      const receipts = JSON.parse(result.stdout);
      assert.equal(receipts.length, 1);
      // Cache entry NOT used — Gemini call attempted, file not found → null confidence
      assert.notEqual(receipts[0].confidence, 'high');
    } finally {
      unlinkSync(tmpList);
      unlinkSync(tmpCache);
    }
  });

  it('skips cache entries with confidence other than high', () => {
    const tmpList = '/tmp/test-extract-receipts-low-conf-list.txt';
    const tmpCache = '/tmp/test-extract-receipts-low-conf-cache.json';
    const lowConfEntry = {
      file: '/receipts/2025/01/blurry.pdf',
      amount_cents: null,
      confidence: null,
      currency: null,
      vendor: null,
      provider_used: 'gemini',
    };
    writeFileSync(tmpList, '/receipts/2025/01/blurry.pdf\n');
    writeFileSync(tmpCache, JSON.stringify([lowConfEntry]));
    try {
      // low-confidence entry not cached → receipt-meta.mjs called → file not found → error entry
      const result = spawnSync(
        'node',
        [scriptPath, tmpList, '--cache', tmpCache],
        { encoding: 'utf8', env: { ...process.env, AI_GEMINI_SA_KEY: '/tmp/nonexistent-key.json' } },
      );
      const receipts = JSON.parse(result.stdout);
      assert.equal(receipts.length, 1);
      // Not the cached null entry — it was re-processed
      assert.equal(receipts[0].provider_used, 'error');
    } finally {
      unlinkSync(tmpList);
      unlinkSync(tmpCache);
    }
  });
});
