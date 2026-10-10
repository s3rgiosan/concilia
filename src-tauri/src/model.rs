//! Data shared by the reconciliation steps, in the JSON shapes stored under each period's
//! `docs/` folder. Unknown fields are kept in `extra` so files round-trip unchanged.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Where a transaction stands after matching or review.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Status {
    Matched,
    Review,
    #[default]
    Unmatched,
}

/// One bank statement line as the parser returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawTransaction {
    /// `DD/MM/YYYY`.
    pub date: String,
    pub description: String,
    /// Signed cents; negative is a debit.
    pub amount_cents: i64,
}

/// A transaction in `transactions.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatementTransaction {
    pub id: String,
    /// ISO 8601 date (`YYYY-MM-DD`).
    pub date: String,
    pub description: String,
    pub amount_cents: i64,
    pub abs_cents: i64,
    #[serde(default)]
    pub status: Status,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// What Gemini extracted from one receipt file, as stored in `receipts.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ReceiptMeta {
    /// Absolute path of the receipt file.
    pub file: String,
    /// Always positive; none when extraction failed.
    #[serde(default)]
    pub amount_cents: Option<i64>,
    #[serde(default)]
    pub confidence: Option<String>,
    /// ISO 4217 code; none when the receipt does not show one.
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub vendor: Option<String>,
    /// ISO 8601 issue date.
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub provider_used: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A transaction in `match-result.json`, with its matched or candidate receipts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Transaction {
    pub id: String,
    pub date: String,
    pub description: String,
    pub amount_cents: i64,
    pub abs_cents: i64,
    #[serde(default)]
    pub status: Status,
    #[serde(default)]
    pub receipt_files: Vec<String>,
    #[serde(default)]
    pub receipt_meta: Vec<ReceiptMeta>,
    /// Why the transaction has its status, such as `amount_match` or `bank_fee`.
    #[serde(default)]
    pub notes: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl From<StatementTransaction> for Transaction {
    fn from(tx: StatementTransaction) -> Transaction {
        let mut extra = tx.extra;
        for key in ["receipt_files", "receipt_meta", "notes"] {
            extra.remove(key);
        }
        Transaction {
            id: tx.id,
            date: tx.date,
            description: tx.description,
            amount_cents: tx.amount_cents,
            abs_cents: tx.abs_cents,
            status: tx.status,
            receipt_files: Vec::new(),
            receipt_meta: Vec::new(),
            notes: String::new(),
            extra,
        }
    }
}

/// Receipt files grouped by the status of the transaction that references them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiptsByStatus {
    #[serde(default)]
    pub matched: Vec<String>,
    #[serde(default)]
    pub review: Vec<String>,
    #[serde(default)]
    pub unmatched: Vec<String>,
}

/// Contents of `match-result.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchResult {
    pub transactions: Vec<Transaction>,
    #[serde(default)]
    pub receipts_by_status: ReceiptsByStatus,
    #[serde(default)]
    pub unmatched_receipts: Vec<ReceiptMeta>,
}

/// A user rule pairing a receipt vendor keyword with a transaction description keyword.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    #[serde(default)]
    pub id: String,
    #[serde(rename = "receiptVendor")]
    pub receipt_vendor: String,
    #[serde(rename = "transactionDescription")]
    pub transaction_description: String,
}

/// Pending review decisions keyed by transaction ID, as stored in `review-draft.json`. Each
/// value holds the transaction fields the decision overrides.
pub type Draft = Map<String, Value>;

/// Counts shown when a run finishes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub total_transactions: usize,
    /// Matched transactions, bank fees included.
    pub matched: usize,
    pub review: usize,
    pub unmatched: usize,
    pub bank_fees: usize,
    pub total_receipts: usize,
    pub matched_receipts: usize,
    pub review_receipts: usize,
    pub unmatched_receipts: usize,
    /// Percentage of transactions matched, bank fees included, rounded.
    pub match_rate: u32,
}

/// A review decision dropped because a receipt it used no longer exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedDecision {
    pub tx_id: String,
    pub description: String,
    /// File names of the receipts that disappeared.
    pub removed_receipt_files: Vec<String>,
}

/// A bank statement whose transactions a period holds, as listed in `statements.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatementRecord {
    /// File name of the statement PDF.
    pub file: String,
    pub bank: crate::bank::Bank,
    /// Transactions the statement added to the period.
    pub transactions: usize,
    /// ISO 8601 UTC timestamp of when it was added.
    pub added_at: String,
}

/// Language of the Excel report.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    #[default]
    En,
    Pt,
}

/// The last path segment, splitting on `/` the way stored receipt paths are written.
pub fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn match_result_round_trips_with_unknown_fields() {
        let value = json!({
            "transactions": [{
                "id": "tx-001-2030-03-01--1000",
                "date": "2030-03-01",
                "description": "ACME CORP",
                "amount_cents": -1000,
                "abs_cents": 1000,
                "status": "MATCHED",
                "receipt_files": ["/r/acme.pdf"],
                "receipt_meta": [{
                    "file": "/r/acme.pdf",
                    "amount_cents": 1000,
                    "confidence": "high",
                    "currency": "EUR",
                    "vendor": "ACME",
                    "date": "2030-03-01",
                    "provider_used": "gemini",
                    "note": "kept"
                }],
                "notes": "amount_match",
                "custom": 1
            }],
            "receiptsByStatus": { "matched": ["/r/acme.pdf"], "review": [], "unmatched": [] },
            "unmatchedReceipts": []
        });
        let parsed: MatchResult = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(parsed.transactions[0].status, Status::Matched);
        assert_eq!(serde_json::to_value(&parsed).unwrap(), value);
    }

    #[test]
    fn receipt_meta_defaults_missing_fields_to_null() {
        let parsed: ReceiptMeta = serde_json::from_value(json!({ "file": "/r/a.pdf" })).unwrap();
        assert_eq!(parsed.amount_cents, None);
        let back = serde_json::to_value(&parsed).unwrap();
        assert_eq!(back["vendor"], Value::Null);
    }

    #[test]
    fn rules_use_the_stored_camel_case_names() {
        let rule: Rule = serde_json::from_value(json!({
            "id": "r1", "receiptVendor": "ACME", "transactionDescription": "ACME CORP"
        }))
        .unwrap();
        assert_eq!(rule.receipt_vendor, "ACME");
        assert_eq!(rule.transaction_description, "ACME CORP");
    }

    #[test]
    fn basename_takes_the_last_segment() {
        assert_eq!(basename("/a/b/c.pdf"), "c.pdf");
        assert_eq!(basename("c.pdf"), "c.pdf");
        assert_eq!(basename(""), "");
    }
}
