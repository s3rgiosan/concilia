const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync, unlinkSync, mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

async function loadPoppler() {
  return await import('../../worker/lib/poppler.mjs');
}
async function loadPdfText() {
  return await import('../../worker/lib/pdf-text.mjs');
}
async function loadPdfRender() {
  return await import('../../worker/lib/pdf-render.mjs');
}

describe('poppler wrappers', () => {
  let savedTotext;
  let savedToppm;
  beforeEach(() => {
    savedTotext = process.env.PDFTOTEXT_BIN;
    savedToppm = process.env.PDFTOPPM_BIN;
  });
  afterEach(() => {
    if (savedTotext === undefined) delete process.env.PDFTOTEXT_BIN;
    else process.env.PDFTOTEXT_BIN = savedTotext;
    if (savedToppm === undefined) delete process.env.PDFTOPPM_BIN;
    else process.env.PDFTOPPM_BIN = savedToppm;
  });

  it('pdftotextLayout throws a clear error when binary is missing', async () => {
    process.env.PDFTOTEXT_BIN = '/nonexistent/pdftotext-binary';
    const { pdftotextLayout } = await loadPoppler();
    assert.throws(
      () => pdftotextLayout(Buffer.from('%PDF-1.4\n')),
      (err) => /pdftotext not found/i.test(err.message),
    );
  });

  it('pdftoppmFirstPage throws a clear error when binary is missing', async () => {
    process.env.PDFTOPPM_BIN = '/nonexistent/pdftoppm-binary';
    const { pdftoppmFirstPage } = await loadPoppler();
    const dir = mkdtempSync(join(tmpdir(), 'concilia-test-'));
    const fakePdf = join(dir, 'fake.pdf');
    writeFileSync(fakePdf, '%PDF-1.4\n');
    try {
      await assert.rejects(
        () => pdftoppmFirstPage(fakePdf),
        (err) => /pdftoppm not found/i.test(err.message),
      );
    } finally {
      try { unlinkSync(fakePdf); } catch { /* */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('extractPdfText delegates to pdftotext (surfaces missing-binary error)', async () => {
    process.env.PDFTOTEXT_BIN = '/nonexistent/pdftotext-binary';
    const { extractPdfText } = await loadPdfText();
    const dir = mkdtempSync(join(tmpdir(), 'concilia-test-'));
    const fakePdf = join(dir, 'fake.pdf');
    writeFileSync(fakePdf, '%PDF-1.4\n');
    try {
      await assert.rejects(
        () => extractPdfText(fakePdf),
        (err) => /pdftotext not found/i.test(err.message),
      );
    } finally {
      try { unlinkSync(fakePdf); } catch { /* */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('renderPdfPageToPng delegates to pdftoppm (surfaces missing-binary error)', async () => {
    process.env.PDFTOPPM_BIN = '/nonexistent/pdftoppm-binary';
    const { renderPdfPageToPng } = await loadPdfRender();
    const dir = mkdtempSync(join(tmpdir(), 'concilia-test-'));
    const fakePdf = join(dir, 'fake.pdf');
    writeFileSync(fakePdf, '%PDF-1.4\n');
    try {
      await assert.rejects(
        () => renderPdfPageToPng(fakePdf),
        (err) => /pdftoppm not found/i.test(err.message),
      );
    } finally {
      try { unlinkSync(fakePdf); } catch { /* */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});
