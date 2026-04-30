import { extractTextFromPDF, parseEuropeanDecimal } from './utils.mjs';

/**
 * Parser for CGD (Caixa Geral de Depósitos, Portugal) PDF statements.
 *
 * Algorithm: extract text with pdfjs -> group by Y-coordinate into lines ->
 * match lines starting with "- - YYYY-MM-DD" -> extract signed amounts
 * in European decimal format. Converts ISO dates to DD/MM/YYYY.
 * Negative amounts = debit/expense, positive = credit/income.
 */

/**
 * Parse a CGD bank statement PDF into transactions.
 *
 * @param {Buffer} buffer - PDF file contents
 * @returns {Promise<Array<{date: string, description: string, amount: number}>>}
 *   Transactions with DD/MM/YYYY dates, negative amounts for debits.
 */
export async function parse(buffer) {
  const lines = await extractTextFromPDF(buffer);
  const transactions = [];

  // European decimal with exactly 2 decimal places (optionally signed)
  const amountPattern = /-?[\d.]+,\d{2}/g;

  for (const line of lines) {
    // Transaction lines start with "- - YYYY-MM-DD" (dashes for mov/value date columns)
    const dateMatch = line.match(/^-\s+-\s+(\d{4}-\d{2}-\d{2})\s+/);
    if (!dateMatch) continue;

    const isoDate = dateMatch[1];

    // Find all European decimal amounts in the line
    const amounts = [...line.matchAll(amountPattern)];
    if (amounts.length < 2) continue;

    // Last = balance, second-to-last = transaction amount
    const amountMatch = amounts[amounts.length - 2];

    // Description is between value date end and amount start
    const descStart = dateMatch[0].length;
    const descEnd = amountMatch.index;
    const description = line.slice(descStart, descEnd).replace(/\s+/g, ' ').trim();

    if (!description) continue;

    const parsedAmount = parseEuropeanDecimal(amountMatch[0]);

    // Convert ISO date (YYYY-MM-DD) to DD/MM/YYYY
    const [year, month, day] = isoDate.split('-');
    const date = `${day}/${month}/${year}`;

    // Concilia convention: negative = debit, positive = credit
    transactions.push({ date, description, amount: parsedAmount });
  }

  return transactions;
}
