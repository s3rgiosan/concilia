/**
 * Transaction–receipt matching engine.
 *
 * Four-pass matching with 3-way sorting and name-based disambiguation.
 * When name+amount produces multiple candidates, the receipt date (extracted
 * by Gemini) breaks the tie within DATE_WINDOW_DAYS.
 *
 * Pass 1 (name + amount, EUR):
 * 1. Bank fee detection (no receipt needed)
 * 2. Receipt filename matches transaction description AND amount within ±5 cents, EUR only
 *    - 1 candidate → MATCHED (highest confidence)
 *    - >1 candidates → date tiebreaker (closest within window) → MATCHED, else REVIEW
 *
 * Pass 2 (amount, EUR):
 * 3. Amount match within ±5 cents, EUR receipts only
 *    - 1 candidate → MATCHED
 *    - >1 candidates → prefer name overlap, then date tiebreaker, else REVIEW
 *
 * Pass 3 (FX):
 * 4. Non-EUR receipts within ±10% of transaction amount
 *    - Candidates found → REVIEW (sorted by date proximity)
 *    - Name overlap required to avoid false positives
 *
 * Pass 4 (filename):
 * 5. Receipt filename matches transaction description (no amount constraint)
 *    - Candidates found → REVIEW (sorted by date proximity)
 *    - 0 candidates → UNMATCHED
 *
 * Receipts are consumed once matched (cannot be reused).
 * REVIEW receipts are NOT consumed.
 */

import { isBankFee } from './bank-fees.mjs';

const TOLERANCE_CENTS = 5;
const FX_TOLERANCE_PERCENT = 10;
const FILENAME_MIN_WORD_LEN = 4;
const DATE_WINDOW_DAYS = 45;
const MS_PER_DAY = 86_400_000;

// Common words to ignore when matching filenames against descriptions
const STOP_WORDS = new Set([
  'invoice', 'receipt', 'fatura', 'recibo', 'compra', 'pagamento',
  'payment', 'fact', 'nota', 'fiscal', 'total', 'para', 'from', 'with',
  '2023', '2024', '2025', '2026', '2027',
]);

/**
 * Extract significant words from a string for name matching.
 * Returns lowercase words with length >= FILENAME_MIN_WORD_LEN, excluding stop words.
 */
function extractWords(text) {
  if (!text) return [];
  return text
    .replace(/[^a-zA-Z0-9\u00C0-\u00FF]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length >= FILENAME_MIN_WORD_LEN && !STOP_WORDS.has(w));
}

/**
 * Check if a transaction description and receipt share significant words.
 * Checks both the filename and the vendor name extracted by Gemini.
 */
function hasNameOverlap(description, receipt) {
  const txWords = extractWords(description);
  if (txWords.length === 0) return false;
  const filename = receipt.file.split('/').pop();
  const fileWords = extractWords(filename);
  const vendorWords = extractWords(receipt.vendor);
  const allReceiptWords = [...fileWords, ...vendorWords];
  return txWords.some(w => allReceiptWords.some(rw => rw.includes(w) || w.includes(rw)));
}

function isEur(receipt) {
  return !receipt.currency || receipt.currency === 'EUR';
}

function daysBetween(txDate, receiptDate) {
  if (!txDate || !receiptDate) return null;
  const a = Date.parse(txDate);
  const b = Date.parse(receiptDate);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.abs(a - b) / MS_PER_DAY;
}

/**
 * Sort candidate receipt indices by date proximity to txDate.
 * Receipts with a date come first (closest first); receipts without a date come last,
 * preserving their relative order. Pure sort — does not filter.
 */
function sortByDateProximity(candidates, txDate, receipts) {
  if (!txDate || candidates.length <= 1) return candidates;
  return [...candidates].sort((a, b) => {
    const da = daysBetween(txDate, receipts[a].date);
    const db = daysBetween(txDate, receipts[b].date);
    if (da === null && db === null) return 0;
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  });
}

/**
 * If exactly one candidate is uniquely closest within DATE_WINDOW_DAYS, return [idx].
 * Otherwise return null (caller falls back to multi-candidate REVIEW).
 */
function pickUniqueByDate(candidates, txDate, receipts) {
  if (!txDate || candidates.length === 0) return null;
  const withDate = candidates
    .map(idx => ({ idx, days: daysBetween(txDate, receipts[idx].date) }))
    .filter(c => c.days !== null && c.days <= DATE_WINDOW_DAYS);
  if (withDate.length === 0) return null;
  withDate.sort((a, b) => a.days - b.days);
  if (withDate.length === 1) return [withDate[0].idx];
  // Tie: closest day count equal between two candidates → not unique
  if (withDate[0].days === withDate[1].days) return null;
  return [withDate[0].idx];
}

/**
 * Check if a rule matches a transaction+receipt pair.
 * Both fields are case-insensitive substrings.
 */
function ruleMatches(rule, description, receipt) {
  const vendor = (receipt.vendor || '').toLowerCase();
  const filename = (receipt.file.split('/').pop() || '').toLowerCase();
  const receiptKeyword = rule.receiptVendor.toLowerCase();
  const desc = description.toLowerCase();
  return (vendor.includes(receiptKeyword) || filename.includes(receiptKeyword)) &&
    desc.includes(rule.transactionDescription.toLowerCase());
}

/**
 * Match transactions against receipts.
 *
 * @param {object[]} transactions
 * @param {object[]} receipts
 * @param {object[]} [rules] - Optional custom matching rules
 */
export function matchTransactions(transactions, receipts, rules = []) {
  // Track which receipts are available (not yet consumed)
  const available = new Set();
  for (let i = 0; i < receipts.length; i++) {
    available.add(i);
  }

  // Build amount index: abs_cents -> [receipt indices]
  const amountIndex = new Map();
  for (let i = 0; i < receipts.length; i++) {
    if (receipts[i].amount_cents == null) continue;
    const cents = receipts[i].amount_cents;
    if (!amountIndex.has(cents)) amountIndex.set(cents, []);
    amountIndex.get(cents).push(i);
  }

  function findAmountCandidates(absCents, filter) {
    const candidates = [];
    for (let c = absCents - TOLERANCE_CENTS; c <= absCents + TOLERANCE_CENTS; c++) {
      const indices = amountIndex.get(c);
      if (!indices) continue;
      for (const idx of indices) {
        if (available.has(idx) && filter(receipts[idx])) candidates.push(idx);
      }
    }
    return candidates;
  }

  function findFxCandidates(absCents) {
    const lo = Math.floor(absCents * (1 - FX_TOLERANCE_PERCENT / 100));
    const hi = Math.ceil(absCents * (1 + FX_TOLERANCE_PERCENT / 100));
    const candidates = [];
    for (const [cents, indices] of amountIndex) {
      if (cents < lo || cents > hi) continue;
      for (const idx of indices) {
        if (!available.has(idx)) continue;
        if (isEur(receipts[idx])) continue;  // explicit EUR: strict pass 1/2 only
        candidates.push(idx);  // non-EUR and unknown currency: FX candidate
      }
    }
    return candidates;
  }

  function preferNameOverlap(candidates, description) {
    if (candidates.length <= 1) return candidates;
    const named = candidates.filter(idx => hasNameOverlap(description, receipts[idx]));
    return named.length > 0 ? named : candidates;
  }

  function matchSingle(out, idx, notes) {
    out.status = 'MATCHED';
    out.receipt_files = [receipts[idx].file];
    out.receipt_meta = [receipts[idx]];
    out.notes = notes;
    available.delete(idx);
    matchedReceiptFiles.push(receipts[idx].file);
  }

  function markReview(out, candidates, notes) {
    out.status = 'REVIEW';
    out.receipt_files = candidates.map(idx => receipts[idx].file);
    out.receipt_meta = candidates.map(idx => receipts[idx]);
    out.notes = notes;
    for (const idx of candidates) {
      reviewReceiptFiles.push(receipts[idx].file);
    }
  }

  const matchedReceiptFiles = [];
  const reviewReceiptFiles = [];

  // Initialize all transactions
  const result = transactions.map(tx => ({
    ...tx, receipt_files: [], receipt_meta: [], notes: '',
    status: isBankFee(tx.description) ? 'MATCHED' : 'UNMATCHED',
  }));

  // Mark bank fees
  for (const out of result) {
    if (out.status === 'MATCHED') out.notes = 'bank_fee';
  }

  // Pass 0: custom rules (highest priority, before all other passes)
  if (rules.length > 0) {
    let ruleMatchCount = 0;
    for (const out of result) {
      if (out.status !== 'UNMATCHED') continue;
      for (const rule of rules) {
        const candidates = [];
        for (let i = 0; i < receipts.length; i++) {
          if (!available.has(i)) continue;
          if (ruleMatches(rule, out.description, receipts[i])) candidates.push(i);
        }
        if (candidates.length === 1) {
          process.stderr.write(`[matcher] rule "${rule.transactionDescription}→${rule.receiptVendor}" matched "${out.description}" → ${receipts[candidates[0]].file}\n`);
          matchSingle(out, candidates[0], `rule_match (${rule.receiptVendor})`);
          ruleMatchCount++;
          break;
        } else if (candidates.length > 1) {
          markReview(out, candidates, `rule_match (${rule.receiptVendor})`);
          ruleMatchCount++;
          break;
        }
      }
    }
    process.stderr.write(`[matcher] pass 0: ${ruleMatchCount} rule match(es) from ${rules.length} rule(s)\n`);
  }

  // Pass 1: name + amount match, EUR only (highest confidence)
  for (const out of result) {
    if (out.status !== 'UNMATCHED') continue;

    const candidates = findAmountCandidates(out.abs_cents, r => isEur(r))
      .filter(idx => hasNameOverlap(out.description, receipts[idx]));

    if (candidates.length === 1) {
      matchSingle(out, candidates[0], 'name_amount_match');
    } else if (candidates.length > 1) {
      const dated = pickUniqueByDate(candidates, out.date, receipts);
      if (dated && dated.length === 1) {
        matchSingle(out, dated[0], 'name_amount_date_match');
      } else {
        const sorted = sortByDateProximity(candidates, out.date, receipts);
        markReview(out, sorted, `${candidates.length} receipts match name+amount`);
      }
    }
  }

  // Pass 2: amount match, EUR only (±5 cents)
  for (const out of result) {
    if (out.status !== 'UNMATCHED') continue;

    let candidates = findAmountCandidates(out.abs_cents, r => isEur(r));
    candidates = preferNameOverlap(candidates, out.description);

    if (candidates.length === 1) {
      const rcptCurrency = receipts[candidates[0]].currency;
      const notes = rcptCurrency && rcptCurrency !== 'EUR'
        ? `amount_match (currency: ${rcptCurrency})`
        : 'amount_match';
      matchSingle(out, candidates[0], notes);
    } else if (candidates.length > 1) {
      const dated = pickUniqueByDate(candidates, out.date, receipts);
      if (dated && dated.length === 1) {
        matchSingle(out, dated[0], 'name_amount_date_match');
      } else {
        const sorted = sortByDateProximity(candidates, out.date, receipts);
        markReview(out, sorted, `${candidates.length} receipts match amount`);
      }
    }
  }

  // Pass 3: FX matching, non-EUR receipts within ±10%
  // Name overlap is required — without it the amount proximity alone creates too many false
  // positives (same-price USD receipt wrongly suggested for an unrelated transaction).
  // Receipts with no name overlap stay in the unmatched pool for manual assignment.
  for (const out of result) {
    if (out.status !== 'UNMATCHED') continue;

    const fxCandidates = findFxCandidates(out.abs_cents);
    if (fxCandidates.length === 0) continue;

    const namedCandidates = fxCandidates.filter(idx => hasNameOverlap(out.description, receipts[idx]));
    if (namedCandidates.length === 0) continue;

    const sorted = sortByDateProximity(namedCandidates, out.date, receipts);
    const notes = sorted.length === 1
      ? `fx_match (${receipts[sorted[0]].currency} ±${FX_TOLERANCE_PERCENT}%)`
      : `${sorted.length} fx receipts within ±${FX_TOLERANCE_PERCENT}%`;
    markReview(out, sorted, notes);
  }

  // Build set of consumed receipt indices (matched in passes 1-2)
  const consumed = new Set();
  for (let i = 0; i < receipts.length; i++) {
    if (!available.has(i)) consumed.add(i);
  }

  // Pass 4: filename matching for still-unmatched transactions
  // Considers ALL unconsumed receipts (including null-amount ones).
  // EUR receipts with a known amount that doesn't fit within ±TOLERANCE_CENTS are excluded —
  // they were already rejected by passes 1-2 on amount grounds.
  for (const out of result) {
    if (out.status !== 'UNMATCHED') continue;

    const txWords = extractWords(out.description);
    if (txWords.length === 0) continue;

    const candidates = [];
    for (let i = 0; i < receipts.length; i++) {
      if (consumed.has(i)) continue;
      // EUR receipts: only include if amount is unknown or within tolerance
      if (receipts[i].currency === 'EUR' && receipts[i].amount_cents !== null) {
        if (Math.abs(receipts[i].amount_cents - out.abs_cents) > TOLERANCE_CENTS) continue;
      }
      if (hasNameOverlap(out.description, receipts[i])) {
        candidates.push(i);
      }
    }

    if (candidates.length === 0) continue;

    const sorted = sortByDateProximity(candidates, out.date, receipts);
    const notes = sorted.length === 1
      ? `filename_match (${receipts[sorted[0]].file.split('/').pop()})`
      : `${sorted.length} receipts match by filename`;
    markReview(out, sorted, notes);
  }

  // Determine receipt file disposition
  const matchedSet = new Set(matchedReceiptFiles);
  const reviewSet = new Set(reviewReceiptFiles);
  const unmatchedReceiptFiles = [];
  for (let i = 0; i < receipts.length; i++) {
    const f = receipts[i].file;
    if (matchedSet.has(f)) continue;
    if (reviewSet.has(f)) continue;
    unmatchedReceiptFiles.push(f);
  }

  return {
    transactions: result,
    receiptsByStatus: {
      matched: [...matchedSet],
      review: [...new Set(reviewReceiptFiles)],
      unmatched: unmatchedReceiptFiles,
    },
    unmatchedReceipts: receipts.filter((r) => {
      return !matchedSet.has(r.file) && !reviewSet.has(r.file);
    }),
  };
}
