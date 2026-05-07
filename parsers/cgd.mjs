import { extractTextWithPoppler, parseEuropeanDecimal } from './utils.mjs';

/**
 * Parser for CGD (Caixa Geral de Depósitos, Portugal) PDF statements.
 *
 * Uses poppler's pdftotext (-layout) because CGD PDFs embed Type 3 fonts
 * with custom encoding for the Data Mov. column — pdfjs returns "-" placeholders
 * instead of the actual digits. Poppler decodes them correctly.
 *
 * Layout per transaction row (after pdftotext -layout):
 *   <leading spaces> Data Mov.   Data Valor   Description ...   Amount   Balance
 *   e.g.: "   2024-12-15 2024-12-13 EXAMPLE FEE   1,00   100,00"
 *
 * Date returned = Data Mov. (when the transaction was posted), in DD/MM/YYYY.
 * Negative amount = debit/expense, positive = credit/income.
 */

const TX_LINE_RE = /^\s*(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})\s+(.+?)\s+(-?[\d.]+,\d{2})\s+(-?[\d.]+,\d{2})\s*$/;

/**
 * Parse a CGD bank statement PDF into transactions.
 *
 * @param {Buffer} buffer - PDF file contents
 * @returns {Promise<Array<{date: string, description: string, amount: number}>>}
 *   Transactions with DD/MM/YYYY dates (Data Mov.), negative amounts for debits.
 */
export async function parse(buffer) {
  const lines = extractTextWithPoppler(buffer);
  const transactions = [];

  for (const line of lines) {
    const m = line.match(TX_LINE_RE);
    if (!m) continue;

    const [, dataMov, , rawDescription, rawAmount] = m;
    const description = rawDescription.replace(/\s+/g, ' ').trim();
    if (!description) continue;

    const [year, month, day] = dataMov.split('-');
    const date = `${day}/${month}/${year}`;
    const amount = parseEuropeanDecimal(rawAmount);

    transactions.push({ date, description, amount });
  }

  return transactions;
}
