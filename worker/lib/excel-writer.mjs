/**
 * Excel report writer using write-excel-file.
 *
 * Writes a single-sheet workbook:
 *   - "Reconciled" — transactions with status colour, receipt names, notes
 *
 * Sheet name + column headers are localized via the `lang` option ("en" | "pt").
 */

import { basename } from 'node:path';
import writeXlsxFile from 'write-excel-file/node';

// Hex backgrounds for the status column (no leading FF alpha)
const STATUS_BG = {
  MATCHED: '#C6EFCE',
  REVIEW: '#FFEB9C',
  UNMATCHED: '#FFC7CE',
};

const TRANSLATIONS = {
  en: {
    sheetReconciled: 'Reconciled',
    tx: {
      date: 'Date',
      description: 'Description',
      amount: 'Amount',
      status: 'Status',
      receiptFile: 'Receipt File',
      receiptAmount: 'Receipt Amount',
      receiptConfidence: 'Receipt Confidence',
      receiptCurrency: 'Receipt Currency',
      notes: 'Notes',
    },
    confidence: {
      high: 'High',
    },
    notes: {
      bankFeeAuto: 'Bank fee (auto)',
      nameAmountMatch: 'Name & amount match',
      nameAmountDateMatch: 'Name, amount & date match',
      amountMatch: 'Amount match',
      filenameMatch: 'Filename match — verify amounts',
      manualMatch: 'Manual match',
      ruleMatch: (vendor) => `Rule match (${vendor})`,
      fxMatch: (detail) => `FX match (${detail})`,
      multipleNameAmount: (n) => n === 1 ? '1 receipt matches name & amount' : `${n} receipts match name & amount`,
      multipleAmount: (n) => n === 1 ? '1 receipt matches amount' : `${n} receipts match amount`,
      multipleFx: (n, tol) => n === 1 ? `1 FX receipt within ${tol}` : `${n} FX receipts within ${tol}`,
      multipleFilename: (n) => n === 1 ? '1 receipt matches by filename' : `${n} receipts match by filename`,
      noReceipt: {
        bank_fee: 'Bank fee',
        salary: 'Salary',
        transfer: 'Transfer',
        refund: 'Refund',
        other: 'No receipt',
      },
    },
  },
  pt: {
    sheetReconciled: 'Reconciliados',
    tx: {
      date: 'Data',
      description: 'Descrição',
      amount: 'Valor',
      status: 'Estado',
      receiptFile: 'Ficheiro do Recibo',
      receiptAmount: 'Valor do Recibo',
      receiptConfidence: 'Confiança do Recibo',
      receiptCurrency: 'Moeda do Recibo',
      notes: 'Notas',
    },
    confidence: {
      high: 'Alta',
    },
    notes: {
      bankFeeAuto: 'Comissão bancária (auto)',
      nameAmountMatch: 'Nome e valor coincidentes',
      nameAmountDateMatch: 'Nome, valor e data coincidentes',
      amountMatch: 'Valor coincidente',
      filenameMatch: 'Nome de ficheiro — verificar valores',
      manualMatch: 'Associação manual',
      ruleMatch: (vendor) => `Regra de correspondência (${vendor})`,
      fxMatch: (detail) => `Correspondência FX (${detail})`,
      multipleNameAmount: (n) => n === 1 ? '1 recibo coincide em nome e valor' : `${n} recibos coincidem em nome e valor`,
      multipleAmount: (n) => n === 1 ? '1 recibo coincide em valor' : `${n} recibos coincidem em valor`,
      multipleFx: (n, tol) => n === 1 ? `1 recibo FX dentro de ${tol}` : `${n} recibos FX dentro de ${tol}`,
      multipleFilename: (n) => n === 1 ? '1 recibo coincide pelo nome do ficheiro' : `${n} recibos coincidem pelo nome do ficheiro`,
      noReceipt: {
        bank_fee: 'Comissão bancária',
        salary: 'Salário',
        transfer: 'Transferência',
        refund: 'Reembolso',
        other: 'Sem recibo',
      },
    },
  },
};

const NO_RECEIPT_KEYS = new Set(['bank_fee', 'salary', 'transfer', 'refund', 'other']);

function formatConfidence(value, dict) {
  if (!value) return '';
  return dict.confidence[value] || value;
}

/**
 * Translate the matcher's `notes` codes into a localized human-readable label.
 * Mirrors the client-side logic in client/src/components/ReviewScreen.tsx.
 */
function formatNotes(notes, dict) {
  if (!notes) return '';
  const n = dict.notes;

  // User-set "no receipt" categories (override matcher output).
  // `bank_fee` overlaps with auto-detected bank fees — treat both as the same label.
  if (NO_RECEIPT_KEYS.has(notes)) {
    if (notes === 'bank_fee') return n.bankFeeAuto;
    return n.noReceipt[notes];
  }

  if (notes === 'name_amount_match') return n.nameAmountMatch;
  if (notes === 'name_amount_date_match') return n.nameAmountDateMatch;
  if (notes === 'amount_match') return n.amountMatch;
  if (notes.startsWith('fx_match')) {
    const detail = notes.match(/\(([^)]+)\)/)?.[1] ?? '';
    return n.fxMatch(detail);
  }
  if (notes.startsWith('filename_match')) return n.filenameMatch;
  if (notes === 'manual_match') return n.manualMatch;
  if (notes.startsWith('rule_match')) {
    const vendor = notes.match(/\(([^)]+)\)/)?.[1] ?? '';
    return n.ruleMatch(vendor);
  }

  let m;
  if ((m = notes.match(/^(\d+) receipts match name\+amount$/))) return n.multipleNameAmount(Number(m[1]));
  if ((m = notes.match(/^(\d+) receipts match amount$/))) return n.multipleAmount(Number(m[1]));
  if ((m = notes.match(/^(\d+) fx receipts within (.+)$/))) return n.multipleFx(Number(m[1]), m[2]);
  if ((m = notes.match(/^(\d+) receipts match by filename$/))) return n.multipleFilename(Number(m[1]));

  // Unknown code — return as-is rather than dropping data.
  return notes;
}

function getDict(lang) {
  return TRANSLATIONS[lang] || TRANSLATIONS.en;
}

/**
 * Build a string cell for write-excel-file.
 * @param {string|number|null} value
 * @param {object} [extra] - additional cell-style props (fontWeight, backgroundColor, format, etc.)
 */
function cell(value, extra = {}) {
  return { value, type: String, ...extra };
}

/**
 * Build a numeric cell from cents. Renders as a true number with 2-decimal
 * formatting so Excel treats it as a value (sortable, summable, no leading
 * apostrophe). Empty string for null cents (write-excel-file skips the cell).
 *
 * @param {number|null} cents
 * @param {object} [extra]
 */
function moneyCell(cents, extra = {}) {
  if (cents == null) return { value: '', type: String, ...extra };
  return { value: cents / 100, type: Number, format: '#,##0.00', ...extra };
}

function buildTxSheet(transactions, dict) {
  // Column order: Date, Description, Amount, Status, Receipt File,
  // Receipt Amount, Receipt Confidence, Receipt Currency, Notes
  const headers = [
    dict.tx.date,
    dict.tx.description,
    dict.tx.amount,
    dict.tx.status,
    dict.tx.receiptFile,
    dict.tx.receiptAmount,
    dict.tx.receiptConfidence,
    dict.tx.receiptCurrency,
    dict.tx.notes,
  ];
  const headerRow = headers.map((h) => cell(h, { fontWeight: 'bold' }));
  const dataRows = (transactions || []).map((tx) => {
    const meta = tx.receipt_meta || [];
    const fileNames = (tx.receipt_files || []).map((f) => basename(f)).join('; ');
    const amounts = meta.map((m) => (m && m.amount_cents != null ? (m.amount_cents / 100).toFixed(2) : '')).join('; ');
    const confidences = meta.map((m) => formatConfidence(m && m.confidence, dict)).join('; ');
    const currencies = meta.map((m) => (m && m.currency) || '').join('; ');
    const statusBg = STATUS_BG[tx.status];
    return [
      cell(tx.date),
      cell(tx.description),
      moneyCell(tx.amount_cents),
      cell(tx.status, statusBg ? { backgroundColor: statusBg } : {}),
      cell(fileNames),
      cell(amounts),
      cell(confidences),
      cell(currencies),
      cell(formatNotes(tx.notes, dict)),
    ];
  });
  return [headerRow, ...dataRows];
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
 * @param {{ lang?: 'en' | 'pt' }} [opts]
 */
export async function writeExcelReport(result, outputPath, opts = {}) {
  const dict = getDict(opts.lang);
  const txRows = buildTxSheet(result.transactions, dict);

  await writeXlsxFile(
    txRows,
    {
      sheet: dict.sheetReconciled,
      columns: autoColumnWidths(txRows, 9),
      filePath: outputPath,
    },
  );
}
