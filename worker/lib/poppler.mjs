import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve a poppler binary path. Prefers the matching env var (Electron main
 * sets these to the bundled binary path), falls back to the system PATH.
 */
function resolveBin(envVar, defaultName) {
  return process.env[envVar] || defaultName;
}

/**
 * Run `pdftotext -layout` against a PDF buffer and return the raw text output.
 * Layout mode preserves column alignment via whitespace — required for
 * statements where label/value pairs sit side-by-side.
 *
 * @param {Buffer} buffer - PDF file contents
 * @returns {string} Plain text with column alignment preserved
 */
export function pdftotextLayout(buffer) {
  const bin = resolveBin('PDFTOTEXT_BIN', 'pdftotext');
  let stdout;
  try {
    stdout = execFileSync(bin, ['-layout', '-enc', 'UTF-8', '-', '-'], {
      input: buffer,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`pdftotext not found (tried "${bin}"). Install poppler (brew install poppler) or set PDFTOTEXT_BIN.`);
    }
    throw err;
  }
  return stdout.toString('utf8');
}

/**
 * Render a single PDF page to a PNG buffer using `pdftoppm`. Default page 1
 * at 300 DPI — matches the previous pdfjs+napi-canvas behaviour for receipt
 * vision fallback.
 *
 * @param {string} filePath - Path to a PDF on disk
 * @param {{ dpi?: number, page?: number }} [opts]
 * @returns {Promise<{ imageBase64: string, mimeType: 'image/png' } | null>}
 *   null if the requested page does not exist.
 */
export async function pdftoppmFirstPage(filePath, opts = {}) {
  const dpi = opts.dpi ?? 300;
  const page = opts.page ?? 1;
  const bin = resolveBin('PDFTOPPM_BIN', 'pdftoppm');

  const dir = mkdtempSync(join(tmpdir(), 'concilia-render-'));
  try {
    const prefix = join(dir, 'page');
    try {
      execFileSync(
        bin,
        ['-png', '-r', String(dpi), '-f', String(page), '-l', String(page), filePath, prefix],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`pdftoppm not found (tried "${bin}"). Install poppler (brew install poppler) or set PDFTOPPM_BIN.`);
      }
      throw err;
    }
    // pdftoppm writes "<prefix>-<page>.png" with zero-padding that depends on
    // total page count. Find whatever it produced for this page number.
    const png = readdirSync(dir).find((f) => f.endsWith('.png'));
    if (!png) return null;
    const buf = readFileSync(join(dir, png));
    return { imageBase64: buf.toString('base64'), mimeType: 'image/png' };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
