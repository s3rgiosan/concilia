import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Extract text lines from a PDF buffer using pdfjs-dist.
 *
 * Groups text items by Y-coordinate into lines, sorts top-to-bottom
 * (PDF coordinates start from the bottom), left-to-right within each line.
 *
 * @param {Buffer} buffer - PDF file contents
 * @returns {Promise<string[]>} Array of text lines
 */
export async function extractTextFromPDF(buffer) {
  const uint8Array = new Uint8Array(buffer);
  const doc = await pdfjsLib.getDocument({ data: uint8Array, verbosity: 0 }).promise;
  const allLines = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const items = textContent.items;

    // Group text items by Y position
    const lineMap = new Map();

    for (const item of items) {
      const y = Math.round(item.transform[5]);
      const x = item.transform[4];

      if (!lineMap.has(y)) {
        lineMap.set(y, []);
      }
      lineMap.get(y).push({ x, text: item.str });
    }

    // Sort by Y descending (PDF coords start from bottom)
    const sortedYs = [...lineMap.keys()].sort((a, b) => b - a);

    for (const y of sortedYs) {
      const lineItems = lineMap.get(y).sort((a, b) => a.x - b.x);
      const lineText = lineItems.map((i) => i.text).join(' ');
      if (lineText.trim()) {
        allLines.push(lineText.trim());
      }
    }
  }

  return allLines;
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
