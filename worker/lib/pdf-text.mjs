import { readFile } from 'node:fs/promises';
import { pdftotextLayout } from './poppler.mjs';

/**
 * Extract text from a PDF, preserving column layout. Mimics — and now is —
 * `pdftotext -layout`: text on the same row keeps its relative horizontal
 * spacing so label/value pairs stay on one line.
 *
 * @param {string} filePath
 * @returns {Promise<string>} Plain text. Throws on PDF parse failure (caller handles).
 */
export async function extractPdfText(filePath) {
  const buf = await readFile(filePath);
  return pdftotextLayout(buf);
}
