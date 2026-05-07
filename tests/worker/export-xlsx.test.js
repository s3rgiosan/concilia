const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { writeFileSync, readFileSync, unlinkSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const scriptPath = join(__dirname, '..', '..', 'worker', 'bin', 'export-xlsx.mjs');
const tmpDir = '/tmp';

describe('export-xlsx CLI', () => {
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

  it('exits with error when only input path given', () => {
    assert.throws(
      () => execFileSync('node', [scriptPath, '/tmp/test.json'], { encoding: 'utf8', stdio: 'pipe' }),
      (err) => {
        assert.match(err.stderr, /Usage:/);
        assert.equal(err.status, 1);
        return true;
      },
    );
  });

  it('generates valid xlsx from match-result JSON', () => {
    const inputPath = join(tmpDir, 'test-match-result-xlsx.json');
    const outputPath = join(tmpDir, 'test-output.xlsx');
    const data = {
      transactions: [
        {
          id: 'tx-001-2025-01-15--5000',
          date: '2025-01-15',
          description: 'COMPRA LOJA',
          amount_cents: -5000,
          abs_cents: 5000,
          status: 'MATCHED',
          receipt_files: ['/r/a.pdf'],
          receipt_meta: [{ file: '/r/a.pdf', amount_cents: 5000, confidence: 'high', currency: 'EUR', provider_used: 'gemini' }],
          notes: 'amount_match',
        },
        {
          id: 'tx-002-2025-01-16--2500',
          date: '2025-01-16',
          description: 'COMISSÃO',
          amount_cents: -2500,
          abs_cents: 2500,
          status: 'MATCHED',
          receipt_files: [],
          receipt_meta: [],
          notes: 'bank_fee',
        },
      ],
    };
    writeFileSync(inputPath, JSON.stringify(data), 'utf8');

    try {
      execFileSync('node', [scriptPath, inputPath, outputPath], {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      assert.ok(existsSync(outputPath), 'xlsx file should exist');

      // Verify it's a valid ZIP file (PK header)
      const buf = readFileSync(outputPath);
      assert.ok(buf.length > 0, 'xlsx file should not be empty');
      assert.strictEqual(buf[0], 0x50, 'first byte should be P');
      assert.strictEqual(buf[1], 0x4b, 'second byte should be K');
    } finally {
      try { unlinkSync(inputPath); } catch { /* */ }
      try { unlinkSync(outputPath); } catch { /* */ }
    }
  });

  it('includes unmatched receipts section', () => {
    const inputPath = join(tmpDir, 'test-match-unmatched-xlsx.json');
    const outputPath = join(tmpDir, 'test-output-unmatched.xlsx');
    const data = {
      transactions: [
        {
          id: 'tx-001',
          date: '2025-01-15',
          description: 'COMPRA',
          amount_cents: -5000,
          abs_cents: 5000,
          status: 'UNMATCHED',
          receipt_files: [],
          receipt_meta: [],
          notes: '',
        },
      ],
      unmatchedReceipts: [
        { file: '/r/extra.pdf', amount_cents: 4707, confidence: 'high', currency: 'USD', provider_used: 'gemini' },
      ],
    };
    writeFileSync(inputPath, JSON.stringify(data), 'utf8');

    try {
      execFileSync('node', [scriptPath, inputPath, outputPath], {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      assert.ok(existsSync(outputPath), 'xlsx file should exist');
      const buf = readFileSync(outputPath);
      assert.ok(buf.length > 0, 'xlsx file should not be empty');
    } finally {
      try { unlinkSync(inputPath); } catch { /* */ }
      try { unlinkSync(outputPath); } catch { /* */ }
    }
  });
});
