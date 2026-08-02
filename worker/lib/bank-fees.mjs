/**
 * Bank fee detection patterns.
 *
 * Transactions matching these patterns are automatically classified as bank fees
 * and don't require receipt matching.
 */

export const noReceiptPatterns = [
  // Portuguese
  /comiss[aã]o/i,
  /\bimposto\b.*\bselo\b/i,
  /juros/i,
  /\bmanut.*\bconta\b/i,
  /\btaxa\b.*\bmanut/i,
  /anuidade/i,
  /\bdespesas\b.*\bconta\b/i,
  /\bseguro\b/i,
  /\bmulta\b/i,
  /provis[aã]o/i,
  // English
  /\bfee\b/i,
  /\bcommission\b/i,
  /\binterest\b/i,
  /\bannual\s+(?:\w+\s+)?charge\b/i,
  /\baccount.*maintenance\b/i,
  /\bstamp.*duty\b/i,
  /\boverdraft\b/i,
  /\bwire\s+(?:\w+\s+)?transfer\b/i,
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
