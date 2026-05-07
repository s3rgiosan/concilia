import { execFileSync } from 'node:child_process';

/**
 * Resolve the pdftotext binary path. Prefers PDFTOTEXT_BIN env var (Electron
 * main sets this to the bundled binary path), falls back to "pdftotext" on PATH.
 */
function resolvePdftotextBin() {
  return process.env.PDFTOTEXT_BIN || 'pdftotext';
}

/**
 * Extract text from a PDF using poppler's pdftotext with -layout (preserves
 * column alignment via whitespace). Required for PDFs that use Type 3 fonts
 * with custom encodings — pdfjs cannot decode those reliably (CGD statements
 * are a known case where the Data Mov column is dropped by pdfjs).
 *
 * @param {Buffer} buffer - PDF file contents
 * @returns {string[]} Array of text lines (whitespace preserved within line)
 * @throws {Error} If pdftotext is not available
 */
export function extractTextWithPoppler(buffer) {
  const bin = resolvePdftotextBin();
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
  return stdout.toString('utf8').split('\n');
}

/**
 * Parse European decimal format (1.234,56 or -1.234,56) to a standard number.
 *
 * @param {string} value - European-formatted number string
 * @returns {number}
 */
export function parseEuropeanDecimal(value) {
  if (!value || value.trim() === '') return 0;
  const normalized = value.trim().replace(/\./g, '').replace(',', '.');
  return parseFloat(normalized);
}
