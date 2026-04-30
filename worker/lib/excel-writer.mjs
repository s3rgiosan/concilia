/**
 * Excel report writer using exceljs.
 *
 * Generates an .xlsx file with formatted transaction data,
 * color-coded status column, and optional unmatched receipts section.
 */

import ExcelJS from 'exceljs';

const STATUS_FILLS = {
  MATCHED: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } },
  REVIEW: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEB9C' } },
  UNMATCHED: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } },
};

const HEADERS = [
  'id', 'date', 'description', 'amount', 'status',
  'receipt_file(s)', 'notes', 'receipt_amount', 'receipt_confidence', 'receipt_currency',
];

/**
 * Write an Excel report from a match result object.
 *
 * @param {object} result - Match result with transactions and unmatchedReceipts
 * @param {string} outputPath - Path to write .xlsx file
 */
export async function writeExcelReport(result, outputPath) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Reconciliation');

  // Add headers
  const headerRow = sheet.addRow(HEADERS);
  headerRow.font = { bold: true };

  // Add transaction rows
  for (const tx of result.transactions) {
    const meta = (tx.receipt_meta || [])[0];
    const row = sheet.addRow([
      tx.id,
      tx.date,
      tx.description,
      (tx.amount_cents / 100).toFixed(2),
      tx.status,
      (tx.receipt_files || []).join('; '),
      tx.notes || '',
      meta && meta.amount_cents != null ? (meta.amount_cents / 100).toFixed(2) : '',
      meta ? meta.confidence || '' : '',
      meta ? meta.currency || '' : '',
    ]);

    // Color the status cell
    const statusCell = row.getCell(5);
    const fill = STATUS_FILLS[tx.status];
    if (fill) statusCell.fill = fill;
  }

  // Append unmatched receipts section if any
  const unmatchedReceipts = result.unmatchedReceipts || [];
  if (unmatchedReceipts.length > 0) {
    sheet.addRow([]); // blank row

    const labelRow = sheet.addRow(['--- UNMATCHED RECEIPTS ---']);
    labelRow.font = { bold: true };

    const subHeaderRow = sheet.addRow(['file', 'amount', 'confidence', 'currency', 'provider']);
    subHeaderRow.font = { bold: true };

    for (const r of unmatchedReceipts) {
      sheet.addRow([
        r.file || '',
        r.amount_cents != null ? (r.amount_cents / 100).toFixed(2) : '',
        r.confidence || '',
        r.currency || '',
        r.provider_used || '',
      ]);
    }
  }

  // Auto-adjust column widths
  for (const column of sheet.columns) {
    let maxLength = 0;
    column.eachCell({ includeEmpty: true }, (cell) => {
      const len = cell.value ? String(cell.value).length : 0;
      if (len > maxLength) maxLength = len;
    });
    column.width = Math.min(Math.max(maxLength + 2, 10), 50);
  }

  await workbook.xlsx.writeFile(outputPath);
}
