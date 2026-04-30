const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');

let excelWriterModule;
async function loadExcelWriter() {
  if (!excelWriterModule) {
    excelWriterModule = await import('../../worker/lib/excel-writer.mjs');
  }
  return excelWriterModule;
}

let ExcelJS;
async function loadExcelJS() {
  if (!ExcelJS) {
    const resolved = require.resolve('exceljs', { paths: [join(__dirname, '..', '..', 'worker')] });
    ExcelJS = require(resolved);
  }
  return ExcelJS;
}

const tmpDir = '/tmp';

describe('writeExcelReport', () => {
  it('writes correct transaction cell values', async () => {
    const { writeExcelReport } = await loadExcelWriter();
    const EJ = await loadExcelJS();
    const outputPath = join(tmpDir, `test-excel-content-${Date.now()}.xlsx`);

    const result = {
      transactions: [
        {
          id: 'tx-001-2025-01-15--5000',
          date: '2025-01-15',
          description: 'COMPRA LOJA',
          amount_cents: -5000,
          abs_cents: 5000,
          status: 'MATCHED',
          receipt_files: ['/r/a.pdf'],
          receipt_meta: [{ file: '/r/a.pdf', amount_cents: 5000, confidence: 'high', currency: 'EUR', provider_used: 'gemini' }],
          notes: 'amount_match',
        },
        {
          id: 'tx-002-2025-01-16--2500',
          date: '2025-01-16',
          description: 'COMISSAO',
          amount_cents: -2500,
          abs_cents: 2500,
          status: 'MATCHED',
          receipt_files: [],
          receipt_meta: [],
          notes: 'bank_fee',
        },
        {
          id: 'tx-003-2025-01-17--9999',
          date: '2025-01-17',
          description: 'UNKNOWN PURCHASE',
          amount_cents: -9999,
          abs_cents: 9999,
          status: 'UNMATCHED',
          receipt_files: [],
          receipt_meta: [],
          notes: '',
        },
      ],
    };

    try {
      await writeExcelReport(result, outputPath);

      const workbook = new EJ.Workbook();
      await workbook.xlsx.readFile(outputPath);
      const sheet = workbook.getWorksheet('Reconciliation');
      assert.ok(sheet, 'Reconciliation worksheet should exist');

      // Row 1: headers
      const headers = [];
      sheet.getRow(1).eachCell((cell) => headers.push(cell.value));
      assert.deepEqual(headers, [
        'id', 'date', 'description', 'amount', 'status',
        'receipt_file(s)', 'notes', 'receipt_amount', 'receipt_confidence', 'receipt_currency',
      ]);

      // Row 2: MATCHED transaction
      const row2 = sheet.getRow(2);
      assert.equal(row2.getCell(1).value, 'tx-001-2025-01-15--5000');
      assert.equal(row2.getCell(2).value, '2025-01-15');
      assert.equal(row2.getCell(3).value, 'COMPRA LOJA');
      assert.equal(row2.getCell(4).value, '-50.00');
      assert.equal(row2.getCell(5).value, 'MATCHED');
      assert.equal(row2.getCell(6).value, '/r/a.pdf');
      assert.equal(row2.getCell(7).value, 'amount_match');
      assert.equal(row2.getCell(8).value, '50.00');
      assert.equal(row2.getCell(9).value, 'high');
      assert.equal(row2.getCell(10).value, 'EUR');

      // Row 3: bank fee (no receipt meta)
      const row3 = sheet.getRow(3);
      assert.equal(row3.getCell(5).value, 'MATCHED');
      assert.equal(row3.getCell(7).value, 'bank_fee');

      // Row 4: UNMATCHED
      const row4 = sheet.getRow(4);
      assert.equal(row4.getCell(5).value, 'UNMATCHED');
    } finally {
      try { unlinkSync(outputPath); } catch { /* */ }
    }
  });

  it('applies correct status fill colors', async () => {
    const { writeExcelReport } = await loadExcelWriter();
    const EJ = await loadExcelJS();
    const outputPath = join(tmpDir, `test-excel-colors-${Date.now()}.xlsx`);

    const result = {
      transactions: [
        { id: 't1', date: '2025-01-01', description: 'A', amount_cents: -100, abs_cents: 100, status: 'MATCHED', receipt_files: [], receipt_meta: [], notes: '' },
        { id: 't2', date: '2025-01-02', description: 'B', amount_cents: -200, abs_cents: 200, status: 'REVIEW', receipt_files: [], receipt_meta: [], notes: '' },
        { id: 't3', date: '2025-01-03', description: 'C', amount_cents: -300, abs_cents: 300, status: 'UNMATCHED', receipt_files: [], receipt_meta: [], notes: '' },
      ],
    };

    try {
      await writeExcelReport(result, outputPath);

      const workbook = new EJ.Workbook();
      await workbook.xlsx.readFile(outputPath);
      const sheet = workbook.getWorksheet('Reconciliation');

      // Status column is column 5
      const matchedFill = sheet.getRow(2).getCell(5).fill;
      assert.equal(matchedFill.fgColor.argb, 'FFC6EFCE', 'MATCHED should be green');

      const reviewFill = sheet.getRow(3).getCell(5).fill;
      assert.equal(reviewFill.fgColor.argb, 'FFFFEB9C', 'REVIEW should be yellow');

      const unmatchedFill = sheet.getRow(4).getCell(5).fill;
      assert.equal(unmatchedFill.fgColor.argb, 'FFFFC7CE', 'UNMATCHED should be red');
    } finally {
      try { unlinkSync(outputPath); } catch { /* */ }
    }
  });

  it('includes unmatched receipts section with correct content', async () => {
    const { writeExcelReport } = await loadExcelWriter();
    const EJ = await loadExcelJS();
    const outputPath = join(tmpDir, `test-excel-unmatched-${Date.now()}.xlsx`);

    const result = {
      transactions: [
        { id: 't1', date: '2025-01-01', description: 'A', amount_cents: -100, abs_cents: 100, status: 'UNMATCHED', receipt_files: [], receipt_meta: [], notes: '' },
      ],
      unmatchedReceipts: [
        { file: '/r/extra.pdf', amount_cents: 4707, confidence: 'high', currency: 'USD', provider_used: 'gemini' },
        { file: '/r/unknown.jpg', amount_cents: null, confidence: null, currency: null, provider_used: 'gemini' },
      ],
    };

    try {
      await writeExcelReport(result, outputPath);

      const workbook = new EJ.Workbook();
      await workbook.xlsx.readFile(outputPath);
      const sheet = workbook.getWorksheet('Reconciliation');

      // Row 1: headers, Row 2: transaction, Row 3: blank, Row 4: label, Row 5: sub-headers, Row 6-7: receipts
      const labelRow = sheet.getRow(4);
      assert.equal(labelRow.getCell(1).value, '--- UNMATCHED RECEIPTS ---');

      const subHeaders = [];
      sheet.getRow(5).eachCell((cell) => subHeaders.push(cell.value));
      assert.deepEqual(subHeaders, ['file', 'amount', 'confidence', 'currency', 'provider']);

      // First unmatched receipt
      const receiptRow1 = sheet.getRow(6);
      assert.equal(receiptRow1.getCell(1).value, '/r/extra.pdf');
      assert.equal(receiptRow1.getCell(2).value, '47.07');
      assert.equal(receiptRow1.getCell(3).value, 'high');
      assert.equal(receiptRow1.getCell(4).value, 'USD');
      assert.equal(receiptRow1.getCell(5).value, 'gemini');

      // Second unmatched receipt (null amount)
      const receiptRow2 = sheet.getRow(7);
      assert.equal(receiptRow2.getCell(1).value, '/r/unknown.jpg');
      assert.equal(receiptRow2.getCell(2).value, '');
    } finally {
      try { unlinkSync(outputPath); } catch { /* */ }
    }
  });

  it('sets bold headers', async () => {
    const { writeExcelReport } = await loadExcelWriter();
    const EJ = await loadExcelJS();
    const outputPath = join(tmpDir, `test-excel-bold-${Date.now()}.xlsx`);

    const result = { transactions: [], unmatchedReceipts: [] };

    try {
      await writeExcelReport(result, outputPath);

      const workbook = new EJ.Workbook();
      await workbook.xlsx.readFile(outputPath);
      const sheet = workbook.getWorksheet('Reconciliation');

      assert.equal(sheet.getRow(1).font.bold, true, 'header row should be bold');
    } finally {
      try { unlinkSync(outputPath); } catch { /* */ }
    }
  });

  it('handles multiple receipt files joined by semicolon', async () => {
    const { writeExcelReport } = await loadExcelWriter();
    const EJ = await loadExcelJS();
    const outputPath = join(tmpDir, `test-excel-multi-${Date.now()}.xlsx`);

    const result = {
      transactions: [
        {
          id: 't1', date: '2025-01-01', description: 'REVIEW ITEM',
          amount_cents: -100, abs_cents: 100, status: 'REVIEW',
          receipt_files: ['/r/a.pdf', '/r/b.pdf'],
          receipt_meta: [
            { file: '/r/a.pdf', amount_cents: 100, confidence: 'high', currency: 'EUR', provider_used: 'gemini' },
            { file: '/r/b.pdf', amount_cents: 100, confidence: 'high', currency: 'EUR', provider_used: 'gemini' },
          ],
          notes: '2 receipts match amount',
        },
      ],
    };

    try {
      await writeExcelReport(result, outputPath);

      const workbook = new EJ.Workbook();
      await workbook.xlsx.readFile(outputPath);
      const sheet = workbook.getWorksheet('Reconciliation');

      assert.equal(sheet.getRow(2).getCell(6).value, '/r/a.pdf; /r/b.pdf');
    } finally {
      try { unlinkSync(outputPath); } catch { /* */ }
    }
  });
});
