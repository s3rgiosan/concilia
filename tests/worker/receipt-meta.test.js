const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const scriptPath = join(__dirname, '..', '..', 'worker', 'bin', 'receipt-meta.mjs');

describe('receipt-meta CLI', () => {
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

  it('exits with error for non-existent file', () => {
    assert.throws(
      () => execFileSync('node', [scriptPath, '/nonexistent/receipt.pdf', '--sa-key', '/tmp/fake.json'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
      (err) => {
        assert.match(err.stderr, /not found/i);
        assert.equal(err.status, 1);
        return true;
      },
    );
  });

  it('exits with error when --sa-key not provided', () => {
    const { writeFileSync, unlinkSync } = require('node:fs');
    const tmpFile = '/tmp/test-receipt-meta.txt';
    writeFileSync(tmpFile, 'Total: 10,00');
    try {
      assert.throws(
        () => execFileSync('node', [scriptPath, tmpFile], {
          encoding: 'utf8',
          stdio: 'pipe',
        }),
        (err) => {
          assert.match(err.stderr, /--sa-key is required/i);
          assert.equal(err.status, 1);
          return true;
        },
      );
    } finally {
      unlinkSync(tmpFile);
    }
  });
});
