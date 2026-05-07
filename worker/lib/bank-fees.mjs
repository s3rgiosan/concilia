/**
 * Bank fee detection patterns.
 *
 * Transactions matching these patterns are automatically classified as bank fees
 * and don't require receipt matching.
 */

export const noReceiptPatterns = [
  // Portuguese
  /comiss[aã]o/i,
  /imposto.*selo/i,
  /juros/i,
  /manut.*conta/i,
  /taxa.*manut/i,
  /anuidade/i,
  /despesas.*conta/i,
  /\bseguro\b/i,
  /\bmulta\b/i,
  /provis[aã]o/i,
  // English
  /\bfee\b/i,
  /\bcommission\b/i,
  /\binterest\b/i,
  /\bannual.*charge\b/i,
  /\baccount.*maintenance\b/i,
  /\bstamp.*duty\b/i,
  /\boverdraft\b/i,
  /\bwire.*transfer\b/i,
  /\batm\b/i,
];

/**
 * Check if a transaction description matches a bank fee pattern.
 * @param {string} description - Transaction description
 * @returns {boolean}
 */
export function isBankFee(description) {
  if (!description) return false;
  return noReceiptPatterns.some((p) => p.test(description));
}
