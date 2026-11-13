//! Matches bank transactions against receipts.
//!
//! Passes run in order; each one only looks at transactions still UNMATCHED:
//!
//! - Pass 0, user rules: vendor keyword plus description keyword. A receipt whose amount fits
//!   (exact for EUR or unknown currency, within ±10% for a foreign currency) is MATCHED when it
//!   is the only one; several are REVIEW, and receipts that only share the keywords are REVIEW
//!   with `rule_match_amount`.
//! - Pass 1, name and exact amount, EUR receipts. A unique date within the window breaks ties.
//! - Pass 1b, name and exact amount, receipts of unknown currency: always REVIEW.
//! - Pass 2, exact amount, EUR receipts, preferring name overlap; date breaks ties.
//! - Pass 2b, exact amount, receipts of unknown currency: always REVIEW.
//! - Pass 3, foreign-currency receipts within ±10% that share a name word: REVIEW.
//! - Pass 4, receipts sharing a name word, whatever their amount, except EUR receipts with a
//!   known amount that differs: REVIEW.
//!
//! No-receipt rules come first: a transaction whose description holds the rule's keyword is
//! MATCHED with the rule's category as its notes. Bank fees are MATCHED next. Only MATCHED
//! consumes a receipt. REVIEW candidates stay available to later transactions during the passes.
//! At the end, a REVIEW transaction loses each candidate a MATCHED transaction took, and becomes
//! UNMATCHED when none is left.

use std::collections::{HashMap, HashSet};

use crate::bank_fees::is_bank_fee;
use crate::dates::days_between;
use crate::model::{
    basename, MatchResult, ReceiptMeta, ReceiptsByStatus, Rule, StatementTransaction, Status,
    Transaction, BANK_FEE_REASON,
};

const FX_TOLERANCE_PERCENT: i64 = 10;
const FILENAME_MIN_WORD_LEN: usize = 4;
const DATE_WINDOW_DAYS: i64 = 45;

/// Words too common in receipt file names and descriptions to say anything about a match.
const STOP_WORDS: &[&str] = &[
    "invoice",
    "receipt",
    "fatura",
    "recibo",
    "compra",
    "pagamento",
    "payment",
    "fact",
    "nota",
    "fiscal",
    "total",
    "para",
    "from",
    "with",
];

/// Whether a word is a four-digit year from 1900 to 2099, too common to say anything about a match.
fn is_year(word: &str) -> bool {
    word.len() == 4 && word.bytes().all(|b| b.is_ascii_digit()) && matches!(&word[..2], "19" | "20")
}

/// Significant lowercase words: letters, digits and Latin-1 letters, at least four
/// characters, stop words and years removed.
fn extract_words(text: &str) -> Vec<String> {
    let cleaned: String = text
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || ('\u{C0}'..='\u{FF}').contains(&c) {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .to_lowercase();
    cleaned
        .split_whitespace()
        .filter(|w| {
            w.chars().count() >= FILENAME_MIN_WORD_LEN && !STOP_WORDS.contains(w) && !is_year(w)
        })
        .map(str::to_string)
        .collect()
}

fn is_eur(receipt: &ReceiptMeta) -> bool {
    receipt.currency.as_deref() == Some("EUR")
}

fn has_unknown_currency(receipt: &ReceiptMeta) -> bool {
    receipt.currency.is_none()
}

fn is_known_foreign_currency(receipt: &ReceiptMeta) -> bool {
    matches!(receipt.currency.as_deref(), Some(c) if c != "EUR")
}

/// A rule with its keywords lowercased once.
struct LoweredRule<'a> {
    rule: &'a Rule,
    vendor: String,
    description: String,
}

/// A receipt's vendor and file name lowercased once, for the rule keywords.
struct LoweredReceipt {
    vendor: String,
    filename: String,
}

impl LoweredReceipt {
    fn new(receipt: &ReceiptMeta) -> LoweredReceipt {
        LoweredReceipt {
            vendor: receipt.vendor.as_deref().unwrap_or("").to_lowercase(),
            filename: basename(&receipt.file).to_lowercase(),
        }
    }

    fn has_keyword(&self, keyword: &str) -> bool {
        !keyword.is_empty() && (self.vendor.contains(keyword) || self.filename.contains(keyword))
    }
}

/// The FX tolerance band around `abs_cents`, inclusive. The low bound rounds up and the high
/// bound rounds down, so every cent in the band is within the tolerance.
fn fx_bounds(abs_cents: i64) -> (i64, i64) {
    let lo = (abs_cents * (100 - FX_TOLERANCE_PERCENT) + 99) / 100;
    let hi = abs_cents * (100 + FX_TOLERANCE_PERCENT) / 100;
    (lo, hi)
}

/// Whether a receipt's amount fits a transaction for a rule hit: exactly for EUR or an
/// unknown currency, within the FX tolerance for a foreign currency.
fn amount_fits(receipt: &ReceiptMeta, abs_cents: i64) -> bool {
    let Some(cents) = receipt.amount_cents else {
        return false;
    };
    if is_known_foreign_currency(receipt) {
        let (lo, hi) = fx_bounds(abs_cents);
        (lo..=hi).contains(&cents)
    } else {
        cents == abs_cents
    }
}

/// Which receipts an exact-amount pass considers.
#[derive(Clone, Copy)]
enum Currency {
    /// EUR receipts: a single candidate is MATCHED.
    Eur,
    /// Receipts without a currency: candidates are always REVIEW.
    Unknown,
}

/// How an exact-amount pass treats the receipt's name.
#[derive(Clone, Copy)]
enum NameFilter {
    /// Only receipts sharing a name word with the description.
    Required,
    /// Receipts sharing a name word when several candidates exist, otherwise all of them.
    Preferred,
}

/// One exact-amount pass over the unmatched transactions.
struct AmountPass {
    currency: Currency,
    name: NameFilter,
    /// Notes for a single EUR candidate.
    matched_note: &'static str,
    /// Notes for a EUR candidate singled out by date.
    dated_note: &'static str,
    /// What the REVIEW notes say the receipts matched on.
    review_label: &'static str,
}

const NAME_AND_AMOUNT_EUR: AmountPass = AmountPass {
    currency: Currency::Eur,
    name: NameFilter::Required,
    matched_note: "name_amount_match",
    dated_note: "name_amount_date_match",
    review_label: "name+amount",
};

const NAME_AND_AMOUNT_UNKNOWN: AmountPass = AmountPass {
    currency: Currency::Unknown,
    name: NameFilter::Required,
    matched_note: "",
    dated_note: "",
    review_label: "name+amount",
};

const AMOUNT_EUR: AmountPass = AmountPass {
    currency: Currency::Eur,
    name: NameFilter::Preferred,
    matched_note: "amount_match",
    dated_note: "amount_date_match",
    review_label: "amount",
};

const AMOUNT_UNKNOWN: AmountPass = AmountPass {
    currency: Currency::Unknown,
    name: NameFilter::Preferred,
    matched_note: "",
    dated_note: "",
    review_label: "amount",
};

struct Matcher<'a> {
    receipts: &'a [ReceiptMeta],
    available: Vec<bool>,
    /// Receipt indexes by amount, in receipt order; amounts in first-seen order.
    amount_index: Vec<(i64, Vec<usize>)>,
    amount_slot: HashMap<i64, usize>,
    receipt_words: Vec<Vec<String>>,
    tx_words: HashMap<String, Vec<String>>,
    matched_files: Vec<String>,
    review_files: Vec<String>,
}

impl<'a> Matcher<'a> {
    fn new(receipts: &'a [ReceiptMeta]) -> Matcher<'a> {
        let mut amount_index: Vec<(i64, Vec<usize>)> = Vec::new();
        let mut amount_slot = HashMap::new();
        for (i, receipt) in receipts.iter().enumerate() {
            let Some(cents) = receipt.amount_cents else {
                continue;
            };
            let slot = *amount_slot.entry(cents).or_insert_with(|| {
                amount_index.push((cents, Vec::new()));
                amount_index.len() - 1
            });
            amount_index[slot].1.push(i);
        }
        let receipt_words = receipts
            .iter()
            .map(|r| {
                let mut words = extract_words(basename(&r.file));
                words.extend(extract_words(r.vendor.as_deref().unwrap_or("")));
                words
            })
            .collect();
        Matcher {
            receipts,
            available: vec![true; receipts.len()],
            amount_index,
            amount_slot,
            receipt_words,
            tx_words: HashMap::new(),
            matched_files: Vec::new(),
            review_files: Vec::new(),
        }
    }

    fn tx_words(&mut self, description: &str) -> &[String] {
        if !self.tx_words.contains_key(description) {
            self.tx_words
                .insert(description.to_string(), extract_words(description));
        }
        &self.tx_words[description]
    }

    fn overlaps(&mut self, description: &str, idx: usize) -> bool {
        self.tx_words(description);
        let words = &self.tx_words[description];
        let receipt_words = &self.receipt_words[idx];
        words.iter().any(|w| {
            receipt_words
                .iter()
                .any(|r| r.contains(w.as_str()) || w.contains(r.as_str()))
        })
    }

    fn amount_candidates(&self, abs_cents: i64, filter: fn(&ReceiptMeta) -> bool) -> Vec<usize> {
        let Some(slot) = self.amount_slot.get(&abs_cents) else {
            return Vec::new();
        };
        self.amount_index[*slot]
            .1
            .iter()
            .copied()
            .filter(|&idx| self.available[idx] && filter(&self.receipts[idx]))
            .collect()
    }

    fn fx_candidates(&self, abs_cents: i64) -> Vec<usize> {
        let (lo, hi) = fx_bounds(abs_cents);
        let mut out = Vec::new();
        for (cents, indexes) in &self.amount_index {
            if *cents < lo || *cents > hi {
                continue;
            }
            for &idx in indexes {
                if self.available[idx] && is_known_foreign_currency(&self.receipts[idx]) {
                    out.push(idx);
                }
            }
        }
        out
    }

    fn prefer_name_overlap(&mut self, candidates: Vec<usize>, description: &str) -> Vec<usize> {
        if candidates.len() <= 1 {
            return candidates;
        }
        let named: Vec<usize> = candidates
            .iter()
            .copied()
            .filter(|&idx| self.overlaps(description, idx))
            .collect();
        if named.is_empty() {
            candidates
        } else {
            named
        }
    }

    /// Candidates with a date first, closest to the transaction first; undated ones last in
    /// their original order.
    fn sort_by_date(&self, mut candidates: Vec<usize>, tx_date: &str) -> Vec<usize> {
        if tx_date.is_empty() || candidates.len() <= 1 {
            return candidates;
        }
        candidates.sort_by(|&a, &b| {
            let da = days_between(tx_date, self.receipts[a].date.as_deref());
            let db = days_between(tx_date, self.receipts[b].date.as_deref());
            match (da, db) {
                (None, None) => std::cmp::Ordering::Equal,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (Some(_), None) => std::cmp::Ordering::Less,
                (Some(x), Some(y)) => x.cmp(&y),
            }
        });
        candidates
    }

    /// The one candidate strictly closest to the transaction date within the window, if any.
    fn unique_by_date(&self, candidates: &[usize], tx_date: &str) -> Option<usize> {
        if tx_date.is_empty() {
            return None;
        }
        let dated: Vec<(usize, i64)> = candidates
            .iter()
            .filter_map(|&idx| {
                let days = days_between(tx_date, self.receipts[idx].date.as_deref())?;
                (days <= DATE_WINDOW_DAYS).then_some((idx, days))
            })
            .collect();
        let min = dated.iter().map(|(_, d)| *d).min()?;
        let mut closest = dated.iter().filter(|(_, d)| *d == min);
        let first = closest.next()?;
        closest.next().is_none().then_some(first.0)
    }

    fn amount_pass(&mut self, result: &mut [Transaction], pass: &AmountPass) {
        for out in result.iter_mut() {
            if out.status != Status::Unmatched {
                continue;
            }
            let filter = match pass.currency {
                Currency::Eur => is_eur,
                Currency::Unknown => has_unknown_currency,
            };
            let candidates = self.amount_candidates(out.abs_cents, filter);
            let candidates = match pass.name {
                NameFilter::Required => candidates
                    .into_iter()
                    .filter(|&idx| self.overlaps(&out.description, idx))
                    .collect(),
                NameFilter::Preferred => self.prefer_name_overlap(candidates, &out.description),
            };
            match pass.currency {
                Currency::Eur => self.settle_eur(out, candidates, pass),
                Currency::Unknown => self.review_unknown_currency(out, candidates, pass),
            }
        }
    }

    fn settle_eur(&mut self, out: &mut Transaction, candidates: Vec<usize>, pass: &AmountPass) {
        match candidates.len() {
            0 => {}
            1 => self.match_single(out, candidates[0], pass.matched_note.into()),
            n => match self.unique_by_date(&candidates, &out.date) {
                Some(idx) => self.match_single(out, idx, pass.dated_note.into()),
                None => {
                    let sorted = self.sort_by_date(candidates, &out.date);
                    let notes = format!("{n} receipts match {}", pass.review_label);
                    self.mark_review(out, &sorted, notes);
                }
            },
        }
    }

    fn review_unknown_currency(
        &mut self,
        out: &mut Transaction,
        candidates: Vec<usize>,
        pass: &AmountPass,
    ) {
        if candidates.is_empty() {
            return;
        }
        let sorted = self.sort_by_date(candidates, &out.date);
        let notes = if sorted.len() == 1 {
            "unknown_currency_match".to_string()
        } else {
            format!(
                "{} receipts match {} (unknown currency)",
                sorted.len(),
                pass.review_label
            )
        };
        self.mark_review(out, &sorted, notes);
    }

    fn match_single(&mut self, out: &mut Transaction, idx: usize, notes: String) {
        let receipt = &self.receipts[idx];
        out.status = Status::Matched;
        out.receipt_files = vec![receipt.file.clone()];
        out.receipt_meta = vec![receipt.clone()];
        out.notes = notes;
        self.available[idx] = false;
        self.matched_files.push(receipt.file.clone());
    }

    fn mark_review(&mut self, out: &mut Transaction, candidates: &[usize], notes: String) {
        out.status = Status::Review;
        out.receipt_files = candidates
            .iter()
            .map(|&i| self.receipts[i].file.clone())
            .collect();
        out.receipt_meta = candidates
            .iter()
            .map(|&i| self.receipts[i].clone())
            .collect();
        out.notes = notes;
        self.review_files.extend(out.receipt_files.iter().cloned());
    }
}

fn unique_in_order(files: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    files
        .iter()
        .filter(|f| seen.insert(f.as_str()))
        .cloned()
        .collect()
}

/// Removes from every REVIEW transaction the candidates that a MATCHED transaction took. A
/// transaction left with no candidate becomes UNMATCHED. A leading candidate count in the notes
/// follows the new count.
fn drop_taken_candidates(result: &mut [Transaction], matched_files: &[String]) {
    let taken: HashSet<&str> = matched_files.iter().map(String::as_str).collect();
    for out in result.iter_mut().filter(|t| t.status == Status::Review) {
        if !out.receipt_files.iter().any(|f| taken.contains(f.as_str())) {
            continue;
        }
        out.receipt_meta
            .retain(|m| !taken.contains(m.file.as_str()));
        out.receipt_files = out.receipt_meta.iter().map(|m| m.file.clone()).collect();
        if out.receipt_files.is_empty() {
            out.status = Status::Unmatched;
            out.notes = String::new();
            continue;
        }
        let digits = out.notes.chars().take_while(char::is_ascii_digit).count();
        if digits > 0 && out.notes[digits..].starts_with(' ') {
            out.notes = format!("{}{}", out.receipt_files.len(), &out.notes[digits..]);
        }
    }
}

/// Matches transactions against receipts, applying `rules` first.
pub fn match_transactions(
    transactions: &[StatementTransaction],
    receipts: &[ReceiptMeta],
    rules: &[Rule],
) -> MatchResult {
    let mut m = Matcher::new(receipts);

    let no_receipt_rules: Vec<(String, &str)> = rules
        .iter()
        .filter_map(|rule| {
            let reason = rule.no_receipt.as_deref()?;
            Some((rule.transaction_description.to_lowercase(), reason))
        })
        .filter(|(keyword, _)| !keyword.is_empty())
        .collect();
    let mut result: Vec<Transaction> = transactions
        .iter()
        .cloned()
        .map(|tx| {
            let mut out = Transaction::from(tx);
            let description = out.description.to_lowercase();
            let reason = no_receipt_rules
                .iter()
                .find(|(keyword, _)| description.contains(keyword.as_str()))
                .map(|(_, reason)| *reason);
            if let Some(reason) = reason {
                out.status = Status::Matched;
                out.notes = reason.to_string();
            } else if is_bank_fee(&out.description) {
                out.status = Status::Matched;
                out.notes = BANK_FEE_REASON.to_string();
            } else {
                out.status = Status::Unmatched;
            }
            out
        })
        .collect();

    // Pass 0: user receipt rules.
    let receipt_rules: Vec<&Rule> = rules.iter().filter(|r| r.no_receipt.is_none()).collect();
    if !receipt_rules.is_empty() {
        let lowered_rules: Vec<LoweredRule> = receipt_rules
            .into_iter()
            .map(|rule| LoweredRule {
                rule,
                vendor: rule.receipt_vendor.trim().to_lowercase(),
                description: rule.transaction_description.trim().to_lowercase(),
            })
            .filter(|r| !r.vendor.is_empty() && !r.description.is_empty())
            .collect();
        let lowered_receipts: Vec<LoweredReceipt> =
            receipts.iter().map(LoweredReceipt::new).collect();
        let mut rule_hits = 0;
        for out in result.iter_mut().filter(|t| t.status == Status::Unmatched) {
            let description = out.description.to_lowercase();
            // The first rule whose receipts fit the amount wins; otherwise the first rule with
            // any receipt sends the transaction to REVIEW.
            let mut without_amount: Option<(&Rule, Vec<usize>)> = None;
            let mut settled = false;
            for lowered in lowered_rules
                .iter()
                .filter(|r| description.contains(&r.description))
            {
                let candidates: Vec<usize> = (0..receipts.len())
                    .filter(|&i| m.available[i] && lowered_receipts[i].has_keyword(&lowered.vendor))
                    .collect();
                if candidates.is_empty() {
                    continue;
                }
                let fitting: Vec<usize> = candidates
                    .iter()
                    .copied()
                    .filter(|&i| amount_fits(&receipts[i], out.abs_cents))
                    .collect();
                let notes = format!("rule_match ({})", lowered.rule.receipt_vendor);
                match fitting.len() {
                    0 => {
                        without_amount.get_or_insert((lowered.rule, candidates));
                        continue;
                    }
                    1 => m.match_single(out, fitting[0], notes),
                    _ => m.mark_review(out, &fitting, notes),
                }
                settled = true;
                break;
            }
            if !settled {
                let Some((rule, candidates)) = without_amount else {
                    continue;
                };
                let notes = format!("rule_match_amount ({})", rule.receipt_vendor);
                m.mark_review(out, &candidates, notes);
            }
            rule_hits += 1;
        }
        log::debug!(
            "matcher pass 0: {rule_hits} rule match(es) from {} rule(s)",
            rules.len()
        );
    }

    for pass in [
        NAME_AND_AMOUNT_EUR,
        NAME_AND_AMOUNT_UNKNOWN,
        AMOUNT_EUR,
        AMOUNT_UNKNOWN,
    ] {
        m.amount_pass(&mut result, &pass);
    }

    // Pass 3: foreign currency within the tolerance, name overlap required.
    if receipts
        .iter()
        .any(|r| r.amount_cents.is_some() && is_known_foreign_currency(r))
    {
        for out in result.iter_mut() {
            if out.status != Status::Unmatched {
                continue;
            }
            let named: Vec<usize> = m
                .fx_candidates(out.abs_cents)
                .into_iter()
                .filter(|&idx| m.overlaps(&out.description, idx))
                .collect();
            if named.is_empty() {
                continue;
            }
            let sorted = m.sort_by_date(named, &out.date);
            let notes = if sorted.len() == 1 {
                let currency = receipts[sorted[0]].currency.as_deref().unwrap_or("");
                format!("fx_match ({currency} ±{FX_TOLERANCE_PERCENT}%)")
            } else {
                format!(
                    "{} fx receipts within ±{FX_TOLERANCE_PERCENT}%",
                    sorted.len()
                )
            };
            m.mark_review(out, &sorted, notes);
        }
    }

    // Pass 4: name overlap alone, over every receipt not consumed.
    let consumed: Vec<bool> = m.available.iter().map(|a| !a).collect();
    for out in result.iter_mut() {
        if out.status != Status::Unmatched {
            continue;
        }
        if m.tx_words(&out.description).is_empty() {
            continue;
        }
        let mut candidates = Vec::new();
        for (i, receipt) in receipts.iter().enumerate() {
            if consumed[i] {
                continue;
            }
            if is_eur(receipt) {
                if let Some(cents) = receipt.amount_cents {
                    if cents != out.abs_cents {
                        continue;
                    }
                }
            }
            if m.overlaps(&out.description, i) {
                candidates.push(i);
            }
        }
        if candidates.is_empty() {
            continue;
        }
        let sorted = m.sort_by_date(candidates, &out.date);
        let notes = if sorted.len() == 1 {
            format!("filename_match ({})", basename(&receipts[sorted[0]].file))
        } else {
            format!("{} receipts match by filename", sorted.len())
        };
        m.mark_review(out, &sorted, notes);
    }

    drop_taken_candidates(&mut result, &m.matched_files);
    let held: HashSet<&str> = result
        .iter()
        .filter(|t| t.status == Status::Review)
        .flat_map(|t| t.receipt_files.iter().map(String::as_str))
        .collect();
    let review_files: Vec<String> = m
        .review_files
        .iter()
        .filter(|f| held.contains(f.as_str()))
        .cloned()
        .collect();

    let matched = unique_in_order(&m.matched_files);
    let review = unique_in_order(&review_files);
    let taken: HashSet<&str> = matched
        .iter()
        .chain(review.iter())
        .map(String::as_str)
        .collect();
    let unmatched_receipts: Vec<ReceiptMeta> = receipts
        .iter()
        .filter(|r| !taken.contains(r.file.as_str()))
        .cloned()
        .collect();

    MatchResult {
        transactions: result,
        receipts_by_status: ReceiptsByStatus {
            matched,
            review,
            unmatched: unmatched_receipts.iter().map(|r| r.file.clone()).collect(),
        },
        unmatched_receipts,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_significant_words() {
        assert_eq!(
            extract_words("ACME-Corp_invoice 2025 Café.pdf"),
            ["acme", "corp", "café"]
        );
        assert!(extract_words("").is_empty());
    }

    #[test]
    fn fx_band_uses_exact_integer_bounds() {
        assert_eq!(fx_bounds(100), (90, 110));
        assert_eq!(fx_bounds(1005), (905, 1105));
        assert_eq!(fx_bounds(1000), (900, 1100));
        assert_eq!(fx_bounds(0), (0, 0));
    }
}
