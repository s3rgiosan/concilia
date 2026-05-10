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
      const sheet = workbook.getWorksheet('Validated');
      assert.ok(sheet, 'Validated worksheet should exist');

      // Row 1: headers (English defaults; Notes moved to end)
      const headers = [];
      sheet.getRow(1).eachCell((cell) => headers.push(cell.value));
      assert.deepEqual(headers, [
        'Date', 'Description', 'Amount', 'Status',
        'Receipt File', 'Receipt Amount', 'Receipt Confidence', 'Receipt Currency', 'Notes',
      ]);

      // Row 2: MATCHED transaction. Column order:
      // Date, Description, Amount, Status, Receipt File, Receipt Amount, Receipt Confidence, Receipt Currency, Notes
      const row2 = sheet.getRow(2);
      assert.equal(row2.getCell(1).value, '2025-01-15');
      assert.equal(row2.getCell(2).value, 'COMPRA LOJA');
      assert.equal(row2.getCell(3).value, -50);
      assert.equal(row2.getCell(4).value, 'MATCHED');
      assert.equal(row2.getCell(5).value, 'a.pdf');
      assert.equal(row2.getCell(6).value, '50.00');
      assert.equal(row2.getCell(7).value, 'High');
      assert.equal(row2.getCell(8).value, 'EUR');
      assert.equal(row2.getCell(9).value, 'Amount match');

      // Row 3: bank fee (no receipt meta) — notes is now in column 9 with localized label
      const row3 = sheet.getRow(3);
      assert.equal(row3.getCell(4).value, 'MATCHED');
      assert.equal(row3.getCell(9).value, 'Bank fee (auto)');

      // Row 4: UNMATCHED
      const row4 = sheet.getRow(4);
      assert.equal(row4.getCell(4).value, 'UNMATCHED');
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
      const sheet = workbook.getWorksheet('Validated');

      // Status column is column 4 (id removed)
      const matchedFill = sheet.getRow(2).getCell(4).fill;
      assert.equal(matchedFill.fgColor.argb, 'FFC6EFCE', 'MATCHED should be green');

      const reviewFill = sheet.getRow(3).getCell(4).fill;
      assert.equal(reviewFill.fgColor.argb, 'FFFFEB9C', 'REVIEW should be yellow');

      const unmatchedFill = sheet.getRow(4).getCell(4).fill;
      assert.equal(unmatchedFill.fgColor.argb, 'FFFFC7CE', 'UNMATCHED should be red');
    } finally {
      try { unlinkSync(outputPath); } catch { /* */ }
    }
  });

  it('does not include an unmatched-receipts section', async () => {
    const { writeExcelReport } = await loadExcelWriter();
    const EJ = await loadExcelJS();
    const outputPath = join(tmpDir, `test-excel-no-unmatched-${Date.now()}.xlsx`);

    const result = {
      transactions: [
        { id: 't1', date: '2025-01-01', description: 'A', amount_cents: -100, abs_cents: 100, status: 'UNMATCHED', receipt_files: [], receipt_meta: [], notes: '' },
      ],
      unmatchedReceipts: [
        { file: '/r/extra.pdf', amount_cents: 4707, confidence: 'high', currency: 'USD', provider_used: 'gemini' },
      ],
    };

    try {
      await writeExcelReport(result, outputPath);

      const workbook = new EJ.Workbook();
      await workbook.xlsx.readFile(outputPath);
      const sheet = workbook.getWorksheet('Validated');

      // Only header + 1 transaction row should exist; no unmatched-receipts section
      assert.equal(sheet.actualRowCount, 2);
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
      const sheet = workbook.getWorksheet('Validated');

      // write-excel-file sets fontWeight per cell, not per row
      assert.equal(sheet.getRow(1).getCell(1).font.bold, true, 'header cell should be bold');
    } finally {
      try { unlinkSync(outputPath); } catch { /* */ }
    }
  });

  it('writes Totals sheet with no-receipt total', async () => {
    const { writeExcelReport } = await loadExcelWriter();
    const EJ = await loadExcelJS();
    const outputPath = join(tmpDir, `test-excel-totals-${Date.now()}.xlsx`);

    const result = {
      transactions: [
        { id: 't1', date: '2025-01-01', description: 'EXAMPLE A', amount_cents: -5000, abs_cents: 5000, status: 'MATCHED', receipt_files: [], receipt_meta: [], notes: 'no_receipt' },
        { id: 't2', date: '2025-01-02', description: 'EXAMPLE B', amount_cents: -3000, abs_cents: 3000, status: 'MATCHED', receipt_files: [], receipt_meta: [], notes: 'no_receipt' },
        { id: 't3', date: '2025-01-03', description: 'EXAMPLE C', amount_cents: -1000, abs_cents: 1000, status: 'MATCHED', receipt_files: [], receipt_meta: [], notes: 'bank_fee' },
        { id: 't4', date: '2025-01-04', description: 'EXAMPLE D', amount_cents: -2500, abs_cents: 2500, status: 'MATCHED', receipt_files: ['/r/d.pdf'], receipt_meta: [{ file: '/r/d.pdf', amount_cents: 2500, confidence: 'high', currency: 'EUR', provider_used: 'gemini' }], notes: 'amount_match' },
        { id: 't5', date: '2025-01-05', description: 'EXAMPLE E', amount_cents: -7500, abs_cents: 7500, status: 'UNMATCHED', receipt_files: [], receipt_meta: [], notes: '' },
      ],
      unmatchedReceipts: [
        { file: '/r/u1.pdf', vendor: 'EXAMPLE V1', date: '2025-01-06', amount_cents: 1000, confidence: 'high', currency: 'EUR', provider_used: 'gemini' },
        { file: '/r/u2.pdf', vendor: 'EXAMPLE V2', date: '2025-01-07', amount_cents: 2500, confidence: 'high', currency: 'EUR', provider_used: 'gemini' },
      ],
    };

    try {
      await writeExcelReport(result, outputPath);

      const workbook = new EJ.Workbook();
      await workbook.xlsx.readFile(outputPath);

      const totals = workbook.getWorksheet('Totals');
      assert.ok(totals, 'Totals worksheet should exist');

      // Header row
      assert.equal(totals.getRow(1).getCell(1).value, 'Label');
      assert.equal(totals.getRow(1).getCell(2).value, 'Amount');

      // Row 2: tx without receipt total = -50 + -30 = -80
      assert.equal(totals.getRow(2).getCell(1).value, 'Transactions without receipt');
      assert.equal(totals.getRow(2).getCell(2).value, -80);
      // Row 3: unmatched receipts total = 10 + 25 = 35
      assert.equal(totals.getRow(3).getCell(1).value, 'Unmatched receipts');
      assert.equal(totals.getRow(3).getCell(2).value, 35);
    } finally {
      try { unlinkSync(outputPath); } catch { /* */ }
    }
  });

  it('localizes Totals sheet to pt', async () => {
    const { writeExcelReport } = await loadExcelWriter();
    const EJ = await loadExcelJS();
    const outputPath = join(tmpDir, `test-excel-totals-pt-${Date.now()}.xlsx`);

    const result = {
      transactions: [
        { id: 't1', date: '2025-01-01', description: 'EXAMPLE', amount_cents: -10000, abs_cents: 10000, status: 'MATCHED', receipt_files: [], receipt_meta: [], notes: 'no_receipt' },
      ],
      unmatchedReceipts: [
        { file: '/r/u1.pdf', vendor: 'EXAMPLE V1', date: '2025-01-02', amount_cents: 2500, confidence: 'high', currency: 'EUR', provider_used: 'gemini' },
      ],
    };

    try {
      await writeExcelReport(result, outputPath, { lang: 'pt' });

      const workbook = new EJ.Workbook();
      await workbook.xlsx.readFile(outputPath);

      const totals = workbook.getWorksheet('Totais');
      assert.ok(totals, 'Totais worksheet should exist');
      assert.equal(totals.getRow(1).getCell(1).value, 'Categoria');
      assert.equal(totals.getRow(1).getCell(2).value, 'Valor');
      assert.equal(totals.getRow(2).getCell(1).value, 'Transações sem recibo');
      assert.equal(totals.getRow(2).getCell(2).value, -100);
      assert.equal(totals.getRow(3).getCell(1).value, 'Recibos sem associação');
      assert.equal(totals.getRow(3).getCell(2).value, 25);
    } finally {
      try { unlinkSync(outputPath); } catch { /* */ }
    }
  });

  it('writes Matched / Review / Unmatched receipt sheets', async () => {
    const { writeExcelReport } = await loadExcelWriter();
    const EJ = await loadExcelJS();
    const outputPath = join(tmpDir, `test-excel-receipt-tabs-${Date.now()}.xlsx`);

    const result = {
      transactions: [
        {
          id: 't1', date: '2025-01-01', description: 'EXAMPLE A',
          amount_cents: -5000, abs_cents: 5000, status: 'MATCHED',
          receipt_files: ['/r/a.pdf'],
          receipt_meta: [{ file: '/r/a.pdf', vendor: 'ACME', date: '2025-01-01', amount_cents: 5000, confidence: 'high', currency: 'EUR', provider_used: 'gemini' }],
          notes: 'amount_match',
        },
        {
          id: 't2', date: '2025-01-02', description: 'EXAMPLE B',
          amount_cents: -2000, abs_cents: 2000, status: 'MATCHED',
          receipt_files: [], receipt_meta: [], notes: 'bank_fee',
        },
        {
          id: 't3', date: '2025-01-03', description: 'EXAMPLE C',
          amount_cents: -3000, abs_cents: 3000, status: 'REVIEW',
          receipt_files: ['/r/c.pdf'],
          receipt_meta: [{ file: '/r/c.pdf', vendor: 'WIDGET', date: '2025-01-02', amount_cents: 3000, confidence: 'high', currency: 'EUR', provider_used: 'gemini' }],
          notes: '2 receipts match amount',
        },
        {
          id: 't4', date: '2025-01-04', description: 'EXAMPLE D',
          amount_cents: -7500, abs_cents: 7500, status: 'UNMATCHED',
          receipt_files: [], receipt_meta: [], notes: '',
        },
      ],
      unmatchedReceipts: [
        { file: '/r/u1.pdf', vendor: 'EXAMPLE VENDOR', date: '2025-01-05', amount_cents: 1234, confidence: 'high', currency: 'USD', provider_used: 'gemini' },
      ],
    };

    try {
      await writeExcelReport(result, outputPath);

      const workbook = new EJ.Workbook();
      await workbook.xlsx.readFile(outputPath);

      const matched = workbook.getWorksheet('Matched');
      assert.ok(matched, 'Matched sheet should exist');
      assert.equal(matched.getRow(1).getCell(1).value, 'File');
      // Only t1 has receipt_meta; t2 (bank_fee) excluded.
      assert.equal(matched.actualRowCount, 2);
      assert.equal(matched.getRow(2).getCell(1).value, 'a.pdf');
      assert.equal(matched.getRow(2).getCell(2).value, 'ACME');
      assert.equal(matched.getRow(2).getCell(4).value, 50);
      assert.equal(matched.getRow(2).getCell(8).value, 'EXAMPLE A');

      const review = workbook.getWorksheet('Review');
      assert.ok(review, 'Review sheet should exist');
      assert.equal(review.actualRowCount, 2);
      assert.equal(review.getRow(2).getCell(1).value, 'c.pdf');
      assert.equal(review.getRow(2).getCell(2).value, 'WIDGET');
      assert.equal(review.getRow(2).getCell(8).value, 'EXAMPLE C');

      const unmatched = workbook.getWorksheet('Unmatched');
      assert.ok(unmatched, 'Unmatched sheet should exist');
      assert.equal(unmatched.getRow(1).getCell(1).value, 'File');
      assert.equal(unmatched.actualRowCount, 2);
      assert.equal(unmatched.getRow(2).getCell(1).value, 'u1.pdf');
      assert.equal(unmatched.getRow(2).getCell(2).value, 'EXAMPLE VENDOR');
      assert.equal(unmatched.getRow(2).getCell(4).value, 12.34);
      assert.equal(unmatched.getRow(2).getCell(5).value, 'USD');
    } finally {
      try { unlinkSync(outputPath); } catch { /* */ }
    }
  });

  it('localizes Matched / Review / Unmatched sheet names to pt', async () => {
    const { writeExcelReport } = await loadExcelWriter();
    const EJ = await loadExcelJS();
    const outputPath = join(tmpDir, `test-excel-receipt-tabs-pt-${Date.now()}.xlsx`);

    const result = { transactions: [], unmatchedReceipts: [] };

    try {
      await writeExcelReport(result, outputPath, { lang: 'pt' });

      const workbook = new EJ.Workbook();
      await workbook.xlsx.readFile(outputPath);

      assert.ok(workbook.getWorksheet('Associados'), 'Associados sheet should exist');
      assert.ok(workbook.getWorksheet('Revisão'), 'Revisão sheet should exist');
      assert.ok(workbook.getWorksheet('Sem Associação'), 'Sem Associação sheet should exist');
    } finally {
      try { unlinkSync(outputPath); } catch { /* */ }
    }
  });

  it('writes Reimbursements sheet with TOTAL row and totals line', async () => {
    const { writeExcelReport } = await loadExcelWriter();
    const EJ = await loadExcelJS();
    const outputPath = join(tmpDir, `test-excel-reimbursements-${Date.now()}.xlsx`);

    const result = {
      transactions: [],
      unmatchedReceipts: [],
      reimbursements: [
        { file: '/r/r1.pdf', vendor: 'EXAMPLE V1', date: '2025-01-10', amount_cents: 1500, confidence: 'high', currency: 'EUR', provider_used: 'gemini' },
        { file: '/r/r2.pdf', vendor: 'EXAMPLE V2', date: '2025-01-11', amount_cents: 2500, confidence: 'high', currency: 'EUR', provider_used: 'gemini' },
      ],
    };

    try {
      await writeExcelReport(result, outputPath);

      const workbook = new EJ.Workbook();
      await workbook.xlsx.readFile(outputPath);

      const reimb = workbook.getWorksheet('Reimbursements');
      assert.ok(reimb, 'Reimbursements sheet should exist');
      assert.equal(reimb.getRow(1).getCell(1).value, 'File');
      assert.equal(reimb.getRow(2).getCell(1).value, 'r1.pdf');
      assert.equal(reimb.getRow(2).getCell(2).value, 'EXAMPLE V1');
      assert.equal(reimb.getRow(2).getCell(4).value, 15);
      assert.equal(reimb.getRow(3).getCell(4).value, 25);
      // TOTAL row
      assert.equal(reimb.getRow(4).getCell(1).value, 'TOTAL');
      assert.equal(reimb.getRow(4).getCell(4).value, 40);

      // Totals sheet should now include the reimbursements line
      const totals = workbook.getWorksheet('Totals');
      assert.equal(totals.getRow(4).getCell(1).value, 'Reimbursements (paid personally)');
      assert.equal(totals.getRow(4).getCell(2).value, 40);
    } finally {
      try { unlinkSync(outputPath); } catch { /* */ }
    }
  });

  it('omits Reimbursements sheet when none provided', async () => {
    const { writeExcelReport } = await loadExcelWriter();
    const EJ = await loadExcelJS();
    const outputPath = join(tmpDir, `test-excel-no-reimbursements-${Date.now()}.xlsx`);

    const result = { transactions: [], unmatchedReceipts: [] };

    try {
      await writeExcelReport(result, outputPath);
      const workbook = new EJ.Workbook();
      await workbook.xlsx.readFile(outputPath);
      assert.equal(workbook.getWorksheet('Reimbursements'), undefined);
      assert.equal(workbook.getWorksheet('Reembolsos'), undefined);
    } finally {
      try { unlinkSync(outputPath); } catch { /* */ }
    }
  });

  it('localizes Reimbursements sheet to pt', async () => {
    const { writeExcelReport } = await loadExcelWriter();
    const EJ = await loadExcelJS();
    const outputPath = join(tmpDir, `test-excel-reimbursements-pt-${Date.now()}.xlsx`);

    const result = {
      transactions: [],
      unmatchedReceipts: [],
      reimbursements: [
        { file: '/r/r1.pdf', vendor: 'EXAMPLE', date: '2025-01-10', amount_cents: 1000, confidence: 'high', currency: 'EUR', provider_used: 'gemini' },
      ],
    };

    try {
      await writeExcelReport(result, outputPath, { lang: 'pt' });
      const workbook = new EJ.Workbook();
      await workbook.xlsx.readFile(outputPath);
      const reimb = workbook.getWorksheet('Reembolsos');
      assert.ok(reimb, 'Reembolsos sheet should exist');
      assert.equal(reimb.getRow(1).getCell(1).value, 'Ficheiro');

      const totals = workbook.getWorksheet('Totais');
      assert.equal(totals.getRow(4).getCell(1).value, 'Reembolsos (pagos pessoalmente)');
      assert.equal(totals.getRow(4).getCell(2).value, 10);
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
      const sheet = workbook.getWorksheet('Validated');

      // basenames joined; column shifted left by 1 (id removed)
      assert.equal(sheet.getRow(2).getCell(5).value, 'a.pdf; b.pdf');
    } finally {
      try { unlinkSync(outputPath); } catch { /* */ }
    }
  });
});
