//! Matches bank transactions against receipts.
//!
//! Passes run in order; each one only looks at transactions still UNMATCHED:
//!
//! - Pass 0, user rules: vendor keyword plus description keyword.
//! - Pass 1, name and exact amount, EUR receipts. A unique date within the window breaks ties.
//! - Pass 1b, name and exact amount, receipts of unknown currency: always REVIEW.
//! - Pass 2, exact amount, EUR receipts, preferring name overlap; date breaks ties.
//! - Pass 2b, exact amount, receipts of unknown currency: always REVIEW.
//! - Pass 3, foreign-currency receipts within ±10% that share a name word: REVIEW.
//! - Pass 4, receipts sharing a name word, whatever their amount, except EUR receipts with a
//!   known amount that differs: REVIEW.
//!
//! Bank fees are MATCHED up front. Only MATCHED consumes a receipt; REVIEW candidates stay
//! available to later transactions.

use std::collections::{HashMap, HashSet};

use crate::bank_fees::is_bank_fee;
use crate::model::{
    basename, MatchResult, ReceiptMeta, ReceiptsByStatus, Rule, StatementTransaction, Status,
    Transaction,
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
    "2023",
    "2024",
    "2025",
    "2026",
    "2027",
];

/// Significant lowercase words: letters, digits and Latin-1 letters, at least four
/// characters, stop words removed.
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
        .filter(|w| w.chars().count() >= FILENAME_MIN_WORD_LEN && !STOP_WORDS.contains(w))
        .map(str::to_string)
        .collect()
}

/// Days since 1970-01-01 for an ISO `YYYY-MM-DD` date. A day past the month's end rolls into
/// the next month, as JavaScript's date parser does.
pub fn epoch_days(date: &str) -> Option<i64> {
    let bytes = date.as_bytes();
    let shape_ok = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
    if !shape_ok {
        return None;
    }
    let year: i64 = date[0..4].parse().ok()?;
    let month: i64 = date[5..7].parse().ok()?;
    let day: i64 = date[8..10].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Days from civil, Howard Hinnant's algorithm, for the first of the month.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468 + day - 1)
}

fn days_between(tx_date: &str, receipt_date: Option<&str>) -> Option<i64> {
    let a = epoch_days(tx_date)?;
    let b = epoch_days(receipt_date?)?;
    Some((a - b).abs())
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

fn rule_matches(rule: &Rule, description: &str, receipt: &ReceiptMeta) -> bool {
    let vendor = receipt.vendor.as_deref().unwrap_or("").to_lowercase();
    let filename = basename(&receipt.file).to_lowercase();
    let keyword = rule.receipt_vendor.to_lowercase();
    (vendor.contains(&keyword) || filename.contains(&keyword))
        && description
            .to_lowercase()
            .contains(&rule.transaction_description.to_lowercase())
}

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
        let lo = (abs_cents as f64 * (1.0 - FX_TOLERANCE_PERCENT as f64 / 100.0)).floor() as i64;
        let hi = (abs_cents as f64 * (1.0 + FX_TOLERANCE_PERCENT as f64 / 100.0)).ceil() as i64;
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

/// Matches transactions against receipts, applying `rules` first.
pub fn match_transactions(
    transactions: &[StatementTransaction],
    receipts: &[ReceiptMeta],
    rules: &[Rule],
) -> MatchResult {
    let mut m = Matcher::new(receipts);

    let mut result: Vec<Transaction> = transactions
        .iter()
        .cloned()
        .map(|tx| {
            let mut out = Transaction::from(tx);
            if is_bank_fee(&out.description) {
                out.status = Status::Matched;
                out.notes = "bank_fee".to_string();
            } else {
                out.status = Status::Unmatched;
            }
            out
        })
        .collect();

    // Pass 0: user rules.
    if !rules.is_empty() {
        let mut rule_hits = 0;
        for out in result.iter_mut().filter(|t| t.status == Status::Unmatched) {
            for rule in rules {
                let candidates: Vec<usize> = (0..receipts.len())
                    .filter(|&i| {
                        m.available[i] && rule_matches(rule, &out.description, &receipts[i])
                    })
                    .collect();
                let notes = format!("rule_match ({})", rule.receipt_vendor);
                match candidates.len() {
                    0 => continue,
                    1 => m.match_single(out, candidates[0], notes),
                    _ => m.mark_review(out, &candidates, notes),
                }
                rule_hits += 1;
                break;
            }
        }
        log::debug!(
            "matcher pass 0: {rule_hits} rule match(es) from {} rule(s)",
            rules.len()
        );
    }

    // Pass 1: name and exact amount, EUR.
    for out in result.iter_mut() {
        if out.status != Status::Unmatched {
            continue;
        }
        let candidates: Vec<usize> = m
            .amount_candidates(out.abs_cents, is_eur)
            .into_iter()
            .filter(|&idx| m.overlaps(&out.description, idx))
            .collect();
        match candidates.len() {
            0 => {}
            1 => m.match_single(out, candidates[0], "name_amount_match".into()),
            n => match m.unique_by_date(&candidates, &out.date) {
                Some(idx) => m.match_single(out, idx, "name_amount_date_match".into()),
                None => {
                    let sorted = m.sort_by_date(candidates, &out.date);
                    m.mark_review(out, &sorted, format!("{n} receipts match name+amount"));
                }
            },
        }
    }

    // Pass 1b: name and exact amount, unknown currency.
    for out in result.iter_mut() {
        if out.status != Status::Unmatched {
            continue;
        }
        let candidates: Vec<usize> = m
            .amount_candidates(out.abs_cents, has_unknown_currency)
            .into_iter()
            .filter(|&idx| m.overlaps(&out.description, idx))
            .collect();
        if candidates.is_empty() {
            continue;
        }
        let sorted = m.sort_by_date(candidates, &out.date);
        let notes = if sorted.len() == 1 {
            "unknown_currency_match".to_string()
        } else {
            format!(
                "{} receipts match name+amount (unknown currency)",
                sorted.len()
            )
        };
        m.mark_review(out, &sorted, notes);
    }

    // Pass 2: exact amount, EUR.
    for out in result.iter_mut() {
        if out.status != Status::Unmatched {
            continue;
        }
        let candidates = m.amount_candidates(out.abs_cents, is_eur);
        let candidates = m.prefer_name_overlap(candidates, &out.description);
        match candidates.len() {
            0 => {}
            1 => m.match_single(out, candidates[0], "amount_match".into()),
            n => match m.unique_by_date(&candidates, &out.date) {
                Some(idx) => m.match_single(out, idx, "amount_date_match".into()),
                None => {
                    let sorted = m.sort_by_date(candidates, &out.date);
                    m.mark_review(out, &sorted, format!("{n} receipts match amount"));
                }
            },
        }
    }

    // Pass 2b: exact amount, unknown currency.
    for out in result.iter_mut() {
        if out.status != Status::Unmatched {
            continue;
        }
        let candidates = m.amount_candidates(out.abs_cents, has_unknown_currency);
        let candidates = m.prefer_name_overlap(candidates, &out.description);
        if candidates.is_empty() {
            continue;
        }
        let sorted = m.sort_by_date(candidates, &out.date);
        let notes = if sorted.len() == 1 {
            "unknown_currency_match".to_string()
        } else {
            format!("{} receipts match amount (unknown currency)", sorted.len())
        };
        m.mark_review(out, &sorted, notes);
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

    let matched = unique_in_order(&m.matched_files);
    let review = unique_in_order(&m.review_files);
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
    fn counts_epoch_days_with_month_rollover() {
        assert_eq!(epoch_days("1970-01-01"), Some(0));
        assert_eq!(epoch_days("2030-03-01"), epoch_days("2030-02-29"));
        assert_eq!(
            epoch_days("2028-02-29").unwrap() + 1,
            epoch_days("2028-03-01").unwrap()
        );
        assert_eq!(epoch_days("2030-01-00"), None);
        assert_eq!(epoch_days("2030-13-01"), None);
        assert_eq!(epoch_days("2030-01-32"), None);
        assert_eq!(epoch_days("2030-1-01"), None);
    }
}
