const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const scriptPath = join(__dirname, '..', '..', 'worker', 'bin', 'parse-statement.mjs');

describe('parse-statement CLI', () => {
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

  it('exits with error for missing pdf path', () => {
    assert.throws(
      () => execFileSync('node', [scriptPath, 'cgd'], { encoding: 'utf8', stdio: 'pipe' }),
      (err) => {
        assert.match(err.stderr, /Usage:/);
        assert.equal(err.status, 1);
        return true;
      },
    );
  });

  it('exits with error for non-existent file', () => {
    assert.throws(
      () => execFileSync('node', [scriptPath, 'cgd', '/nonexistent/file.pdf'], {
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
});
