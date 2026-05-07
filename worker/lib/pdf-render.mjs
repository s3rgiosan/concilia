import { pdftoppmFirstPage } from './poppler.mjs';

/**
 * Render the first page of a PDF as a base64-encoded PNG, used for the Gemini
 * vision fallback when text extraction fails or yields garbage.
 *
 * @param {string} filePath
 * @param {{ dpi?: number, page?: number }} [opts]
 * @returns {Promise<{ imageBase64: string, mimeType: 'image/png' } | null>}
 */
export async function renderPdfPageToPng(filePath, opts = {}) {
  return pdftoppmFirstPage(filePath, opts);
}
