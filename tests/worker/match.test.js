const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { writeFileSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');

const scriptPath = join(__dirname, '..', '..', 'worker', 'bin', 'match.mjs');
const tmpDir = '/tmp';

describe('match CLI', () => {
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

  it('exits with error when only one argument given', () => {
    const txPath = join(tmpDir, 'test-match-tx-only.json');
    writeFileSync(txPath, '[]', 'utf8');
    try {
      assert.throws(
        () => execFileSync('node', [scriptPath, txPath], { encoding: 'utf8', stdio: 'pipe' }),
        (err) => {
          assert.match(err.stderr, /Usage:/);
          assert.equal(err.status, 1);
          return true;
        },
      );
    } finally {
      unlinkSync(txPath);
    }
  });

  it('outputs valid JSON match result', () => {
    const txPath = join(tmpDir, 'test-match-transactions.json');
    const rcptPath = join(tmpDir, 'test-match-receipts.json');
    const transactions = [
      { id: 'tx-001', date: '2025-01-15', description: 'COMPRA LOJA', amount_cents: -5000, abs_cents: 5000, status: 'UNMATCHED' },
    ];
    const receipts = [
      { file: '/r/a.pdf', amount_cents: 5000, confidence: 'high', provider_used: 'gemini' },
    ];
    writeFileSync(txPath, JSON.stringify(transactions), 'utf8');
    writeFileSync(rcptPath, JSON.stringify(receipts), 'utf8');

    try {
      const output = execFileSync('node', [scriptPath, txPath, rcptPath], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      const result = JSON.parse(output);
      assert.ok(Array.isArray(result.transactions));
      assert.ok(result.receiptsByStatus);
      assert.strictEqual(result.transactions.length, 1);
    } finally {
      unlinkSync(txPath);
      unlinkSync(rcptPath);
    }
  });

  it('matches a transaction to a receipt by amount', () => {
    const txPath = join(tmpDir, 'test-match-amount-tx.json');
    const rcptPath = join(tmpDir, 'test-match-amount-rcpt.json');
    const transactions = [
      { id: 'tx-001', date: '2025-01-15', description: 'COMPRA', amount_cents: -4599, abs_cents: 4599, status: 'UNMATCHED' },
    ];
    const receipts = [
      { file: '/r/receipt.pdf', amount_cents: 4599, confidence: 'high', provider_used: 'gemini' },
    ];
    writeFileSync(txPath, JSON.stringify(transactions), 'utf8');
    writeFileSync(rcptPath, JSON.stringify(receipts), 'utf8');

    try {
      const output = execFileSync('node', [scriptPath, txPath, rcptPath], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      const result = JSON.parse(output);
      assert.strictEqual(result.transactions[0].status, 'MATCHED');
      assert.deepStrictEqual(result.transactions[0].receipt_files, ['/r/receipt.pdf']);
      assert.strictEqual(result.transactions[0].notes, 'amount_match');
    } finally {
      unlinkSync(txPath);
      unlinkSync(rcptPath);
    }
  });

  it('returns UNMATCHED when no receipt matches', () => {
    const txPath = join(tmpDir, 'test-match-nomatch-tx.json');
    const rcptPath = join(tmpDir, 'test-match-nomatch-rcpt.json');
    const transactions = [
      { id: 'tx-001', date: '2025-01-15', description: 'COMPRA', amount_cents: -9999, abs_cents: 9999, status: 'UNMATCHED' },
    ];
    const receipts = [
      { file: '/r/other.pdf', amount_cents: 1000, confidence: 'high', provider_used: 'gemini' },
    ];
    writeFileSync(txPath, JSON.stringify(transactions), 'utf8');
    writeFileSync(rcptPath, JSON.stringify(receipts), 'utf8');

    try {
      const output = execFileSync('node', [scriptPath, txPath, rcptPath], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      const result = JSON.parse(output);
      assert.strictEqual(result.transactions[0].status, 'UNMATCHED');
      assert.deepStrictEqual(result.transactions[0].receipt_files, []);
    } finally {
      unlinkSync(txPath);
      unlinkSync(rcptPath);
    }
  });

  it('handles empty transactions and receipts', () => {
    const txPath = join(tmpDir, 'test-match-empty-tx.json');
    const rcptPath = join(tmpDir, 'test-match-empty-rcpt.json');
    writeFileSync(txPath, '[]', 'utf8');
    writeFileSync(rcptPath, '[]', 'utf8');

    try {
      const output = execFileSync('node', [scriptPath, txPath, rcptPath], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      const result = JSON.parse(output);
      assert.deepStrictEqual(result.transactions, []);
      assert.deepStrictEqual(result.receiptsByStatus.matched, []);
      assert.deepStrictEqual(result.receiptsByStatus.review, []);
      assert.deepStrictEqual(result.receiptsByStatus.unmatched, []);
    } finally {
      unlinkSync(txPath);
      unlinkSync(rcptPath);
    }
  });

  it('includes receiptsByStatus with correct categorization', () => {
    const txPath = join(tmpDir, 'test-match-status-tx.json');
    const rcptPath = join(tmpDir, 'test-match-status-rcpt.json');
    const transactions = [
      { id: 'tx-001', date: '2025-01-15', description: 'COMPRA A', amount_cents: -5000, abs_cents: 5000, status: 'UNMATCHED' },
    ];
    const receipts = [
      { file: '/r/matched.pdf', amount_cents: 5000, confidence: 'high', provider_used: 'gemini' },
      { file: '/r/extra.pdf', amount_cents: 9999, confidence: 'high', provider_used: 'gemini' },
    ];
    writeFileSync(txPath, JSON.stringify(transactions), 'utf8');
    writeFileSync(rcptPath, JSON.stringify(receipts), 'utf8');

    try {
      const output = execFileSync('node', [scriptPath, txPath, rcptPath], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      const result = JSON.parse(output);
      assert.deepStrictEqual(result.receiptsByStatus.matched, ['/r/matched.pdf']);
      assert.deepStrictEqual(result.receiptsByStatus.unmatched, ['/r/extra.pdf']);
    } finally {
      unlinkSync(txPath);
      unlinkSync(rcptPath);
    }
  });
});
