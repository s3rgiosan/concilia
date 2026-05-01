import { readFile } from 'node:fs/promises';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const Y_TOLERANCE = 2;
const SPACE_GAP_RATIO = 0.4;

/**
 * Extract text from a PDF, preserving column layout via X-gap reconstruction.
 * Mimics `pdftotext -layout`: text items on the same Y row keep their relative
 * horizontal spacing so label/value pairs stay on one line.
 *
 * @param {string} filePath
 * @returns {Promise<string>} Plain text. Throws on PDF parse failure (caller handles).
 */
export async function extractPdfText(filePath) {
  const buf = await readFile(filePath);
  const data = new Uint8Array(buf);
  const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false, verbosity: 0 }).promise;
  try {
    const pageTexts = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pageTexts.push(reconstructLayout(content.items));
      page.cleanup();
    }
    return pageTexts.join('\n\n');
  } finally {
    await doc.destroy();
  }
}

function reconstructLayout(items) {
  if (!items.length) return '';

  const positioned = items
    .filter((it) => it.str && it.str.length > 0)
    .map((it) => {
      const x = it.transform[4];
      const y = it.transform[5];
      const width = it.width || estimateWidth(it);
      const height = it.height || Math.abs(it.transform[3]) || 10;
      return { x, y, width, height, text: it.str };
    });

  if (!positioned.length) return '';

  // Group by Y (within tolerance), descending (PDF coords from bottom).
  positioned.sort((a, b) => b.y - a.y);
  const rows = [];
  let current = null;
  for (const item of positioned) {
    if (current && Math.abs(current.y - item.y) <= Y_TOLERANCE) {
      current.items.push(item);
    } else {
      current = { y: item.y, items: [item] };
      rows.push(current);
    }
  }

  return rows
    .map((row) => {
      row.items.sort((a, b) => a.x - b.x);
      let line = '';
      let cursor = 0;
      for (const item of row.items) {
        const charWidth = item.width / Math.max(item.text.length, 1);
        const gap = item.x - cursor;
        if (line.length === 0) {
          line = item.text;
        } else {
          const spaces = charWidth > 0 ? Math.max(1, Math.round(gap / Math.max(charWidth, 1) * SPACE_GAP_RATIO)) : 1;
          line += ' '.repeat(Math.min(spaces, 40)) + item.text;
        }
        cursor = item.x + item.width;
      }
      return line.trimEnd();
    })
    .filter((line) => line.length > 0)
    .join('\n');
}

function estimateWidth(item) {
  // Fallback when pdfjs doesn't supply width: use font scale as rough estimate.
  const scale = Math.abs(item.transform[0]) || 10;
  return scale * item.str.length * 0.5;
}
