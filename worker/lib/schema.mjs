/**
 * Canonical schema utilities for Concilia.
 *
 * All amounts are stored as signed integer cents to avoid floating-point issues.
 * Dates are stored in ISO 8601 (YYYY-MM-DD) format internally.
 */

/**
 * Convert DD/MM/YYYY to ISO 8601 (YYYY-MM-DD).
 * @param {string} ddmmyyyy - Date in DD/MM/YYYY format
 * @returns {string} Date in YYYY-MM-DD format
 * @throws {Error} If the input format is invalid
 */
export function ddmmyyyyToISO(ddmmyyyy) {
  if (!ddmmyyyy || typeof ddmmyyyy !== 'string') {
    throw new Error(`Invalid date: ${ddmmyyyy}`);
  }
  const m = ddmmyyyy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) {
    throw new Error(`Invalid date format (expected DD/MM/YYYY): ${ddmmyyyy}`);
  }
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Convert a European decimal string (e.g. "1.234,56" or "-45,99") to signed integer cents.
 * @param {number|string} value - Amount as European decimal string or JS number
 * @returns {number} Signed integer cents (e.g. -4599)
 */
export function euroToCents(value) {
  if (typeof value === 'number') {
    return Math.round(value * 100);
  }
  if (!value || typeof value !== 'string' || value.trim() === '') return 0;
  const normalized = value.trim().replace(/\./g, '').replace(',', '.');
  return Math.round(parseFloat(normalized) * 100);
}

/**
 * Generate a deterministic transaction ID from index, date, and amount.
 * @param {number} index - 1-based transaction index within the statement
 * @param {string} isoDate - Date in YYYY-MM-DD format
 * @param {number} amountCents - Signed amount in cents
 * @returns {string} Transaction ID (e.g. "tx-001-2025-01-15--4599")
 */
export function makeTransactionId(index, isoDate, amountCents) {
  const idx = String(index).padStart(3, '0');
  return `tx-${idx}-${isoDate}-${amountCents}`;
}

/**
 * Normalize a parser transaction to canonical schema.
 * @param {{ date: string, description: string, amount: number }} raw - Parser output
 * @param {number} index - 1-based index
 * @returns {{ id: string, date: string, description: string, amount_cents: number, abs_cents: number, status: string }}
 */
export function normalizeTransaction(raw, index) {
  const isoDate = ddmmyyyyToISO(raw.date);
  const amountCents = euroToCents(raw.amount);
  const id = makeTransactionId(index, isoDate, amountCents);
  return {
    id,
    date: isoDate,
    description: raw.description || 'Unknown',
    amount_cents: amountCents,
    abs_cents: Math.abs(amountCents),
    status: 'UNMATCHED',
  };
}
