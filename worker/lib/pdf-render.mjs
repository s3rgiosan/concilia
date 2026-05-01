import { readFile } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const PDF_DEFAULT_DPI = 72;

/**
 * Render the first page of a PDF as a base64-encoded PNG.
 *
 * @param {string} filePath
 * @param {{ dpi?: number, page?: number }} [opts]
 * @returns {Promise<{ imageBase64: string, mimeType: 'image/png' } | null>}
 */
export async function renderPdfPageToPng(filePath, opts = {}) {
  const dpi = opts.dpi ?? 300;
  const pageNum = opts.page ?? 1;
  const scale = dpi / PDF_DEFAULT_DPI;

  const buf = await readFile(filePath);
  const data = new Uint8Array(buf);
  const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false, verbosity: 0 }).promise;
  try {
    if (pageNum < 1 || pageNum > doc.numPages) return null;
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    page.cleanup();
    const png = await canvas.encode('png');
    return { imageBase64: png.toString('base64'), mimeType: 'image/png' };
  } finally {
    await doc.destroy();
  }
}
