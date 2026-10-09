//! Applying pending review decisions to a match result, and summarizing results.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde_json::Value;

use crate::model::{
    basename, Draft, DroppedDecision, MatchResult, ReceiptMeta, Status, Summary, Transaction,
};
use crate::text::js_round;

/// Notes of transactions the user marked as needing no receipt.
pub const NO_RECEIPT_NOTES: &[&str] = &["bank_fee", "salary", "transfer", "refund", "no_receipt"];

#[derive(Debug, thiserror::Error)]
#[error("review decision for {tx_id} is invalid: {source}")]
pub struct InvalidDecision {
    pub tx_id: String,
    #[source]
    pub source: serde_json::Error,
}

/// The transactions with each draft decision laid over its transaction's fields.
pub fn merge_draft(
    result: &MatchResult,
    draft: &Draft,
) -> Result<Vec<Transaction>, InvalidDecision> {
    result
        .transactions
        .iter()
        .map(|tx| {
            let Some(Value::Object(change)) = draft.get(&tx.id) else {
                return Ok(tx.clone());
            };
            let invalid = |source| InvalidDecision {
                tx_id: tx.id.clone(),
                source,
            };
            let mut value = serde_json::to_value(tx).map_err(invalid)?;
            if let Value::Object(fields) = &mut value {
                for (key, field) in change {
                    fields.insert(key.clone(), field.clone());
                }
            }
            serde_json::from_value(value).map_err(invalid)
        })
        .collect()
}

/// Receipt files bound to a MATCHED transaction, which no other transaction can use.
pub fn claimed_files(transactions: &[Transaction]) -> HashSet<String> {
    transactions
        .iter()
        .filter(|tx| tx.status == Status::Matched && !NO_RECEIPT_NOTES.contains(&tx.notes.as_str()))
        .flat_map(|tx| tx.receipt_meta.iter().map(|m| m.file.clone()))
        .collect()
}

/// Receipts free for assignment: the matcher's unmatched receipts, plus the receipts of
/// MATCHED or REVIEW transactions the user sent back to UNMATCHED, minus every claimed receipt.
pub fn effective_unmatched(
    result: &MatchResult,
    draft: &Draft,
    merged: &[Transaction],
) -> Vec<ReceiptMeta> {
    let mut pool: IndexMap<String, ReceiptMeta> = IndexMap::new();
    for receipt in &result.unmatched_receipts {
        pool.insert(receipt.file.clone(), receipt.clone());
    }
    let originals: HashMap<&str, &Transaction> = result
        .transactions
        .iter()
        .map(|t| (t.id.as_str(), t))
        .collect();
    for (tx_id, change) in draft {
        let Some(original) = originals.get(tx_id.as_str()) else {
            continue;
        };
        let sent_back = change.get("status").and_then(Value::as_str) == Some("UNMATCHED");
        if sent_back && matches!(original.status, Status::Review | Status::Matched) {
            for meta in &original.receipt_meta {
                pool.insert(meta.file.clone(), meta.clone());
            }
        }
    }
    for file in claimed_files(merged) {
        pool.shift_remove(&file);
    }
    pool.into_values().collect()
}

/// Drops decisions that reference receipt files missing from `present`, reporting each one.
pub fn clean_draft(
    draft: &Draft,
    present: &HashSet<String>,
    transactions: &[Transaction],
) -> (Draft, Vec<DroppedDecision>) {
    let descriptions: HashMap<&str, &str> = transactions
        .iter()
        .map(|t| (t.id.as_str(), t.description.as_str()))
        .collect();
    let mut kept = Draft::new();
    let mut dropped = Vec::new();
    for (tx_id, change) in draft {
        let referenced = change
            .get("receipt_files")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let removed: Vec<String> = referenced
            .iter()
            .map(|f| f.as_str().unwrap_or_default())
            .filter(|f| !present.contains(*f))
            .map(|f| basename(f).to_string())
            .collect();
        if removed.is_empty() {
            kept.insert(tx_id.clone(), change.clone());
        } else {
            dropped.push(DroppedDecision {
                tx_id: tx_id.clone(),
                description: descriptions
                    .get(tx_id.as_str())
                    .map_or_else(|| tx_id.clone(), |d| d.to_string()),
                removed_receipt_files: removed,
            });
        }
    }
    (kept, dropped)
}

/// Counts for the end of a run.
pub fn summary(result: &MatchResult, total_receipts: usize) -> Summary {
    let txs = &result.transactions;
    let bank_fees = txs.iter().filter(|t| t.notes == "bank_fee").count();
    let matched = txs
        .iter()
        .filter(|t| t.status == Status::Matched && t.notes != "bank_fee")
        .count();
    let review = txs.iter().filter(|t| t.status == Status::Review).count();
    let unmatched = txs.iter().filter(|t| t.status == Status::Unmatched).count();
    let total = txs.len();
    let match_rate = if total > 0 {
        js_round((matched + bank_fees) as f64 / total as f64 * 100.0) as u32
    } else {
        0
    };
    Summary {
        total_transactions: total,
        matched: matched + bank_fees,
        review,
        unmatched,
        bank_fees,
        total_receipts,
        matched_receipts: result.receipts_by_status.matched.len(),
        review_receipts: result.receipts_by_status.review.len(),
        unmatched_receipts: result.receipts_by_status.unmatched.len(),
        match_rate,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn receipt(file: &str, cents: i64) -> ReceiptMeta {
        ReceiptMeta {
            file: file.into(),
            amount_cents: Some(cents),
            confidence: Some("high".into()),
            currency: Some("EUR".into()),
            provider_used: Some("gemini".into()),
            ..Default::default()
        }
    }

    fn tx(id: &str, status: Status, receipts: &[ReceiptMeta], notes: &str) -> Transaction {
        Transaction {
            id: id.into(),
            date: "2030-03-01".into(),
            description: format!("ACME {id}"),
            amount_cents: -1000,
            abs_cents: 1000,
            status,
            receipt_files: receipts.iter().map(|r| r.file.clone()).collect(),
            receipt_meta: receipts.to_vec(),
            notes: notes.into(),
            extra: Default::default(),
        }
    }

    fn draft(value: Value) -> Draft {
        match value {
            Value::Object(map) => map,
            _ => panic!("draft must be an object"),
        }
    }

    fn result() -> MatchResult {
        MatchResult {
            transactions: vec![
                tx(
                    "t1",
                    Status::Matched,
                    &[receipt("/r/a.pdf", 1000)],
                    "amount_match",
                ),
                tx(
                    "t2",
                    Status::Review,
                    &[receipt("/r/b.pdf", 1000), receipt("/r/c.pdf", 1000)],
                    "2 receipts match amount",
                ),
                tx("t3", Status::Unmatched, &[], ""),
            ],
            unmatched_receipts: vec![receipt("/r/d.pdf", 500)],
            ..Default::default()
        }
    }

    #[test]
    fn merges_decisions_over_transactions() {
        let d = draft(json!({
            "t2": { "status": "MATCHED", "receipt_meta": [receipt("/r/c.pdf", 1000)], "receipt_files": ["/r/c.pdf"], "notes": "amount_match" },
            "gone": { "status": "MATCHED" }
        }));
        let merged = merge_draft(&result(), &d).unwrap();
        assert_eq!(merged[1].status, Status::Matched);
        assert_eq!(merged[1].receipt_files, ["/r/c.pdf"]);
        assert_eq!(merged[0], result().transactions[0]);
    }

    #[test]
    fn reports_decisions_that_do_not_fit_a_transaction() {
        let d = draft(json!({ "t1": { "status": "DONE" } }));
        assert_eq!(merge_draft(&result(), &d).unwrap_err().tx_id, "t1");
    }

    #[test]
    fn frees_receipts_of_transactions_sent_back_to_unmatched() {
        let d = draft(json!({
            "t1": { "status": "UNMATCHED", "receipt_meta": [], "receipt_files": [], "notes": "" },
            "t3": { "status": "MATCHED", "receipt_meta": [receipt("/r/d.pdf", 500)], "receipt_files": ["/r/d.pdf"], "notes": "manual_match" }
        }));
        let merged = merge_draft(&result(), &d).unwrap();
        let pool: Vec<String> = effective_unmatched(&result(), &d, &merged)
            .into_iter()
            .map(|r| r.file)
            .collect();
        assert_eq!(pool, ["/r/a.pdf"]);
    }

    #[test]
    fn no_receipt_decisions_claim_nothing() {
        let merged = vec![tx(
            "t1",
            Status::Matched,
            &[receipt("/r/a.pdf", 1000)],
            "transfer",
        )];
        assert!(claimed_files(&merged).is_empty());
    }

    #[test]
    fn drops_decisions_whose_receipts_disappeared() {
        let d = draft(json!({
            "t1": { "status": "MATCHED", "receipt_files": ["/r/a.pdf", "/r/x/missing.pdf"] },
            "t2": { "status": "MATCHED", "receipt_files": ["/r/b.pdf"] },
            "t9": { "status": "UNMATCHED", "receipt_files": ["/r/gone.pdf"] }
        }));
        let present: HashSet<String> = ["/r/a.pdf", "/r/b.pdf"].map(String::from).into();
        let (kept, dropped) = clean_draft(&d, &present, &result().transactions);
        assert_eq!(kept.keys().collect::<Vec<_>>(), ["t2"]);
        assert_eq!(
            dropped,
            vec![
                DroppedDecision {
                    tx_id: "t1".into(),
                    description: "ACME t1".into(),
                    removed_receipt_files: vec!["missing.pdf".into()]
                },
                DroppedDecision {
                    tx_id: "t9".into(),
                    description: "t9".into(),
                    removed_receipt_files: vec!["gone.pdf".into()]
                },
            ]
        );
    }

    #[test]
    fn summarizes_counts_and_rate() {
        let mut r = result();
        r.transactions
            .push(tx("t4", Status::Matched, &[], "bank_fee"));
        r.receipts_by_status.matched = vec!["/r/a.pdf".into()];
        r.receipts_by_status.review = vec!["/r/b.pdf".into(), "/r/c.pdf".into()];
        r.receipts_by_status.unmatched = vec!["/r/d.pdf".into()];
        let s = summary(&r, 4);
        assert_eq!(
            s,
            Summary {
                total_transactions: 4,
                matched: 2,
                review: 1,
                unmatched: 1,
                bank_fees: 1,
                total_receipts: 4,
                matched_receipts: 1,
                review_receipts: 2,
                unmatched_receipts: 1,
                match_rate: 50,
            }
        );
        assert_eq!(summary(&MatchResult::default(), 0).match_rate, 0);
    }
}
