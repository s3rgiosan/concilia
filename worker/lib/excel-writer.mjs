/**
 * Excel report writer using write-excel-file.
 *
 * Writes a workbook with two sheets:
 *   - "Reconciliation" — transactions with status colour, receipt names, notes
 *   - "Unmatched Receipts" — receipts not bound to any transaction, with sum
 */

import { basename } from 'node:path';
import writeXlsxFile from 'write-excel-file/node';

// Hex backgrounds for the status column (no leading FF alpha)
const STATUS_BG = {
  MATCHED: '#C6EFCE',
  REVIEW: '#FFEB9C',
  UNMATCHED: '#FFC7CE',
};

const TX_HEADERS = [
  'date', 'description', 'amount', 'status',
  'receipt_file(s)', 'notes', 'receipt_amount', 'receipt_confidence', 'receipt_currency',
];

const UNMATCHED_HEADERS = ['file', 'amount', 'confidence', 'currency', 'vendor', 'date'];

/**
 * Build a cell descriptor for write-excel-file.
 * @param {string|number|null} value
 * @param {object} [extra] - additional cell-style props (fontWeight, backgroundColor, type, format, etc.)
 */
function cell(value, extra = {}) {
  return { value, type: String, ...extra };
}

function buildTxSheet(transactions) {
  const headerRow = TX_HEADERS.map((h) => cell(h, { fontWeight: 'bold' }));
  const dataRows = (transactions || []).map((tx) => {
    const meta = tx.receipt_meta || [];
    const fileNames = (tx.receipt_files || []).map((f) => basename(f)).join('; ');
    const amounts = meta.map((m) => (m && m.amount_cents != null ? (m.amount_cents / 100).toFixed(2) : '')).join('; ');
    const confidences = meta.map((m) => (m && m.confidence) || '').join('; ');
    const currencies = meta.map((m) => (m && m.currency) || '').join('; ');
    const statusBg = STATUS_BG[tx.status];
    return [
      cell(tx.date),
      cell(tx.description),
      cell((tx.amount_cents / 100).toFixed(2)),
      cell(tx.status, statusBg ? { backgroundColor: statusBg } : {}),
      cell(fileNames),
      cell(tx.notes || ''),
      cell(amounts),
      cell(confidences),
      cell(currencies),
    ];
  });
  return [headerRow, ...dataRows];
}

function buildUnmatchedSheet(unmatchedReceipts) {
  const headerRow = UNMATCHED_HEADERS.map((h) => cell(h, { fontWeight: 'bold' }));
  const items = unmatchedReceipts || [];
  const dataRows = items.map((r) => [
    cell(basename(r.file || '')),
    cell(r.amount_cents != null ? (r.amount_cents / 100).toFixed(2) : ''),
    cell(r.confidence || ''),
    cell(r.currency || ''),
    cell(r.vendor || ''),
    cell(r.date || ''),
  ]);

  // Sum row at the bottom (only over entries with a non-null amount).
  const totalCents = items.reduce((s, r) => s + (r.amount_cents != null ? r.amount_cents : 0), 0);
  const sumRow = [
    cell('TOTAL', { fontWeight: 'bold' }),
    cell((totalCents / 100).toFixed(2), { fontWeight: 'bold' }),
    cell(''),
    cell(''),
    cell(''),
    cell(''),
  ];
  return [headerRow, ...dataRows, sumRow];
}

function autoColumnWidths(rows, headerCount) {
  const widths = [];
  for (let col = 0; col < headerCount; col++) {
    let max = 0;
    for (const r of rows) {
      const v = r[col]?.value;
      const len = v == null ? 0 : String(v).length;
      if (len > max) max = len;
    }
    widths.push({ width: Math.min(Math.max(max + 2, 10), 50) });
  }
  return widths;
}

/**
 * Write a multi-sheet Excel report from a match result object.
 *
 * @param {object} result - Match result with transactions and unmatchedReceipts
 * @param {string} outputPath - Path to write .xlsx file
 */
export async function writeExcelReport(result, outputPath) {
  const txRows = buildTxSheet(result.transactions);
  const unmatchedRows = buildUnmatchedSheet(result.unmatchedReceipts);

  await writeXlsxFile(
    [txRows, unmatchedRows],
    {
      sheets: ['Reconciliation', 'Unmatched Receipts'],
      columns: [autoColumnWidths(txRows, TX_HEADERS.length), autoColumnWidths(unmatchedRows, UNMATCHED_HEADERS.length)],
      filePath: outputPath,
    },
  );
}
