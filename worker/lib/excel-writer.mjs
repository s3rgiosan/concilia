/**
 * Excel report writer using write-excel-file.
 *
 * Writes a multi-sheet workbook:
 *   - "Totals"        — aggregate totals (e.g. signed sum of "no receipt"-tagged matched txs)
 *   - "Validated"     — full transaction list with status colour, receipt names, notes
 *   - "Matched"       — one row per receipt attached to MATCHED transactions
 *   - "Review"        — one row per receipt attached to REVIEW transactions
 *   - "Unmatched"     — one row per unmatched receipt
 *   - "Reimbursements" — one row per receipt paid personally on company VAT (read-only,
 *                        no matcher involvement); appended only when present
 *
 * Sheet names + column headers are localized via the `lang` option ("en" | "pt").
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
    sheetValidated: 'Validated',
    sheetTotals: 'Totals',
    sheetMatched: 'Matched',
    sheetReview: 'Review',
    sheetUnmatched: 'Unmatched',
    sheetReimbursements: 'Reimbursements',
    totals: {
      label: 'Label',
      amount: 'Amount',
      txWithoutReceipt: 'Transactions without receipt',
      unmatchedReceipts: 'Unmatched receipts',
      reimbursements: 'Reimbursements (paid personally)',
    },
    reimbursements: {
      total: 'TOTAL',
    },
    receipt: {
      file: 'File',
      vendor: 'Vendor',
      date: 'Date',
      amount: 'Amount',
      currency: 'Currency',
      confidence: 'Confidence',
      txDate: 'Transaction Date',
      txDescription: 'Transaction Description',
      txAmount: 'Transaction Amount',
    },
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
        no_receipt: 'No receipt',
      },
    },
  },
  pt: {
    sheetValidated: 'Validados',
    sheetTotals: 'Totais',
    sheetMatched: 'Associados',
    sheetReview: 'Revisão',
    sheetUnmatched: 'Sem Associação',
    sheetReimbursements: 'Reembolsos',
    totals: {
      label: 'Categoria',
      amount: 'Valor',
      txWithoutReceipt: 'Transações sem recibo',
      unmatchedReceipts: 'Recibos sem associação',
      reimbursements: 'Reembolsos (pagos pessoalmente)',
    },
    reimbursements: {
      total: 'TOTAL',
    },
    receipt: {
      file: 'Ficheiro',
      vendor: 'Fornecedor',
      date: 'Data',
      amount: 'Valor',
      currency: 'Moeda',
      confidence: 'Confiança',
      txDate: 'Data da Transação',
      txDescription: 'Descrição da Transação',
      txAmount: 'Valor da Transação',
    },
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
        no_receipt: 'Sem recibo',
      },
    },
  },
};

const NO_RECEIPT_KEYS = new Set(['bank_fee', 'salary', 'transfer', 'refund', 'no_receipt']);

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

function buildTotalsSheet(transactions, unmatchedReceipts, reimbursements, dict) {
  const headers = [dict.totals.label, dict.totals.amount];
  const headerRow = headers.map((h) => cell(h, { fontWeight: 'bold' }));

  const txWithoutReceiptCents = (transactions || [])
    .filter((t) => t.status === 'MATCHED' && t.notes === 'no_receipt')
    .reduce((acc, t) => acc + (t.amount_cents || 0), 0);
  const unmatchedReceiptsCents = (unmatchedReceipts || [])
    .reduce((acc, r) => acc + (r.amount_cents || 0), 0);
  const reimbursementsCents = (reimbursements || [])
    .reduce((acc, r) => acc + (r.amount_cents || 0), 0);

  const rows = [
    [cell(dict.totals.txWithoutReceipt), moneyCell(txWithoutReceiptCents)],
    [cell(dict.totals.unmatchedReceipts), moneyCell(unmatchedReceiptsCents)],
  ];
  if ((reimbursements || []).length > 0) {
    rows.push([cell(dict.totals.reimbursements), moneyCell(reimbursementsCents)]);
  }
  return [headerRow, ...rows];
}

/**
 * Build a sheet listing reimbursement receipts (company-VAT, paid personally).
 * Shape mirrors the Unmatched sheet, plus a TOTAL row at the bottom summing
 * `amount_cents`. Column widths must match the header count (6).
 */
function buildReimbursementsSheet(reimbursements, dict) {
  const headers = [
    dict.receipt.file,
    dict.receipt.vendor,
    dict.receipt.date,
    dict.receipt.amount,
    dict.receipt.currency,
    dict.receipt.confidence,
  ];
  const headerRow = headers.map((h) => cell(h, { fontWeight: 'bold' }));
  const dataRows = (reimbursements || []).map((m) => [
    cell(basename(m.file || '')),
    cell(m.vendor || ''),
    cell(m.date || ''),
    moneyCell(m.amount_cents),
    cell(m.currency || ''),
    cell(formatConfidence(m.confidence, dict)),
  ]);
  if (dataRows.length === 0) return [headerRow];
  const totalCents = (reimbursements || []).reduce((acc, r) => acc + (r.amount_cents || 0), 0);
  const totalRow = [
    cell(dict.reimbursements.total, { fontWeight: 'bold' }),
    cell(''),
    cell(''),
    moneyCell(totalCents, { fontWeight: 'bold' }),
    cell(''),
    cell(''),
  ];
  return [headerRow, ...dataRows, totalRow];
}

/**
 * Build a sheet listing receipts associated with transactions of a given status
 * (MATCHED or REVIEW). One row per receipt; each row carries its parent tx info.
 */
function buildTxReceiptSheet(transactions, status, dict) {
  const headers = [
    dict.receipt.file,
    dict.receipt.vendor,
    dict.receipt.date,
    dict.receipt.amount,
    dict.receipt.currency,
    dict.receipt.confidence,
    dict.receipt.txDate,
    dict.receipt.txDescription,
    dict.receipt.txAmount,
  ];
  const headerRow = headers.map((h) => cell(h, { fontWeight: 'bold' }));
  const dataRows = [];
  for (const tx of transactions || []) {
    if (tx.status !== status) continue;
    if (status === 'MATCHED' && NO_RECEIPT_KEYS.has(tx.notes)) continue;
    const meta = tx.receipt_meta || [];
    if (meta.length === 0) continue;
    for (const m of meta) {
      dataRows.push([
        cell(basename(m.file || '')),
        cell(m.vendor || ''),
        cell(m.date || ''),
        moneyCell(m.amount_cents),
        cell(m.currency || ''),
        cell(formatConfidence(m.confidence, dict)),
        cell(tx.date || ''),
        cell(tx.description || ''),
        moneyCell(tx.amount_cents),
      ]);
    }
  }
  return [headerRow, ...dataRows];
}

/**
 * Build a sheet listing receipts that did not match any transaction.
 * Source: result.unmatchedReceipts.
 */
function buildUnmatchedReceiptSheet(unmatchedReceipts, dict) {
  const headers = [
    dict.receipt.file,
    dict.receipt.vendor,
    dict.receipt.date,
    dict.receipt.amount,
    dict.receipt.currency,
    dict.receipt.confidence,
  ];
  const headerRow = headers.map((h) => cell(h, { fontWeight: 'bold' }));
  const dataRows = (unmatchedReceipts || []).map((m) => [
    cell(basename(m.file || '')),
    cell(m.vendor || ''),
    cell(m.date || ''),
    moneyCell(m.amount_cents),
    cell(m.currency || ''),
    cell(formatConfidence(m.confidence, dict)),
  ]);
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
  const reimbursements = result.reimbursements || [];
  const hasReimbursements = reimbursements.length > 0;

  const txRows = buildTxSheet(result.transactions, dict);
  const totalsRows = buildTotalsSheet(result.transactions, result.unmatchedReceipts, reimbursements, dict);
  const matchedRows = buildTxReceiptSheet(result.transactions, 'MATCHED', dict);
  const reviewRows = buildTxReceiptSheet(result.transactions, 'REVIEW', dict);
  const unmatchedRows = buildUnmatchedReceiptSheet(result.unmatchedReceipts, dict);

  const data = [totalsRows, txRows, matchedRows, reviewRows, unmatchedRows];
  const sheets = [
    dict.sheetTotals,
    dict.sheetValidated,
    dict.sheetMatched,
    dict.sheetReview,
    dict.sheetUnmatched,
  ];
  const columns = [
    autoColumnWidths(totalsRows, 2),
    autoColumnWidths(txRows, 9),
    autoColumnWidths(matchedRows, 9),
    autoColumnWidths(reviewRows, 9),
    autoColumnWidths(unmatchedRows, 6),
  ];

  if (hasReimbursements) {
    const reimbRows = buildReimbursementsSheet(reimbursements, dict);
    data.push(reimbRows);
    sheets.push(dict.sheetReimbursements);
    columns.push(autoColumnWidths(reimbRows, 6));
  }

  await writeXlsxFile(data, { sheets, columns, filePath: outputPath });
}
