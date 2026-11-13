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
    /// Why the file was not sent to Gemini, such as `file_too_large`; absent for a file that
    /// was read or tried.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ReceiptMeta {
    /// Metadata for a file that was refused before reading, with the refusal `code`.
    pub fn refused(file: &str, code: &str) -> ReceiptMeta {
        ReceiptMeta {
            file: file.to_string(),
            refused: Some(code.to_string()),
            ..Default::default()
        }
    }

    pub fn is_refused(&self) -> bool {
        self.refused.is_some()
    }
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

/// The reason that stays in every list. Transactions marked with a deleted reason show as this one.
pub const OTHER_REASON: &str = "no_receipt";

/// The reason the bank-fee check marks transactions with.
pub const BANK_FEE_REASON: &str = "bank_fee";

/// The ids of the reasons Concilia ships with.
pub const SHIPPED_REASONS: [&str; 5] = [
    BANK_FEE_REASON,
    "salary",
    "transfer",
    "refund",
    OTHER_REASON,
];

/// The start of the id of a reason the user added.
pub const CUSTOM_REASON_PREFIX: &str = "reason:";

/// Whether `notes` is a reason id, so the transaction needs no receipt. This is true also for
/// the id of a reason the user deleted.
pub fn is_reason_id(notes: &str) -> bool {
    SHIPPED_REASONS.contains(&notes)
        || notes
            .strip_prefix(CUSTOM_REASON_PREFIX)
            .is_some_and(|rest| !rest.trim().is_empty())
}

/// A reason's name in each app language.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ReasonNames {
    pub en: String,
    pub pt: String,
}

impl ReasonNames {
    /// The name in `language`, or the name in the other language when that one is blank.
    pub fn get(&self, language: Language) -> &str {
        let (first, second) = match language {
            Language::En => (&self.en, &self.pt),
            Language::Pt => (&self.pt, &self.en),
        };
        if first.is_empty() {
            second
        } else {
            first
        }
    }
}

/// Why a transaction needs no receipt. A transaction marked with a reason stores the reason's
/// id as its `notes`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reason {
    pub id: String,
    pub names: ReasonNames,
}

/// The reasons Concilia ships with, in menu order.
pub fn default_reasons() -> Vec<Reason> {
    let reason = |id: &str, en: &str, pt: &str| Reason {
        id: id.to_string(),
        names: ReasonNames {
            en: en.to_string(),
            pt: pt.to_string(),
        },
    };
    vec![
        reason(BANK_FEE_REASON, "Bank Fee", "Comissão bancária"),
        reason("salary", "Salary", "Salário"),
        reason("transfer", "Transfer", "Transferência"),
        reason("refund", "Refund", "Reembolso"),
        reason(OTHER_REASON, "Other", "Outro"),
    ]
}

/// The name of the reason `id` in `language`. A deleted reason reads as the Other reason.
pub fn reason_label(reasons: &[Reason], id: &str, language: Language) -> String {
    reasons
        .iter()
        .find(|r| r.id == id)
        .or_else(|| reasons.iter().find(|r| r.id == OTHER_REASON))
        .map(|r| r.names.get(language).to_string())
        .unwrap_or_default()
}

/// Whether the reason `id` reads as the Other reason: it is Other, or it was deleted.
pub fn is_other_reason(reasons: &[Reason], id: &str) -> bool {
    id == OTHER_REASON || (is_reason_id(id) && !reasons.iter().any(|r| r.id == id))
}

/// A user rule keyed on a transaction description keyword. A receipt rule pairs the keyword
/// with a receipt vendor keyword; a no-receipt rule (`no_receipt` set to a reason id, vendor
/// empty) marks the transaction as needing no receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    #[serde(default)]
    pub id: String,
    #[serde(rename = "receiptVendor", default)]
    pub receipt_vendor: String,
    #[serde(rename = "transactionDescription")]
    pub transaction_description: String,
    #[serde(rename = "noReceipt", default, skip_serializing_if = "Option::is_none")]
    pub no_receipt: Option<String>,
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
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
        assert_eq!(rule.no_receipt, None);
        assert!(serde_json::to_value(&rule)
            .unwrap()
            .get("noReceipt")
            .is_none());
    }

    #[test]
    fn no_receipt_rules_need_no_vendor() {
        let rule: Rule = serde_json::from_value(json!({
            "id": "r2", "transactionDescription": "TRF", "noReceipt": "transfer"
        }))
        .unwrap();
        assert_eq!(rule.receipt_vendor, "");
        assert_eq!(rule.no_receipt.as_deref(), Some("transfer"));
        assert_eq!(
            serde_json::to_value(&rule).unwrap()["noReceipt"],
            "transfer"
        );
    }

    #[test]
    fn reason_ids_cover_shipped_and_custom_reasons() {
        for id in SHIPPED_REASONS {
            assert!(is_reason_id(id), "{id}");
        }
        assert!(is_reason_id("reason:abc"));
        assert!(!is_reason_id("reason:"));
        assert!(!is_reason_id("reason: "));
        assert!(!is_reason_id("manual_match"));
        assert!(!is_reason_id(""));
    }

    #[test]
    fn reason_names_fall_back_to_the_other_language() {
        let names = ReasonNames {
            en: "Fee".into(),
            pt: String::new(),
        };
        assert_eq!(names.get(Language::En), "Fee");
        assert_eq!(names.get(Language::Pt), "Fee");
    }

    #[test]
    fn deleted_reasons_read_as_other() {
        let reasons = default_reasons();
        assert_eq!(reason_label(&reasons, "salary", Language::Pt), "Salário");
        assert_eq!(reason_label(&reasons, "reason:gone", Language::En), "Other");
        assert!(is_other_reason(&reasons, OTHER_REASON));
        assert!(is_other_reason(&reasons, "reason:gone"));
        assert!(!is_other_reason(&reasons, "salary"));
        assert!(!is_other_reason(&reasons, "manual_match"));
    }

    #[test]
    fn basename_takes_the_last_segment() {
        assert_eq!(basename("/a/b/c.pdf"), "c.pdf");
        assert_eq!(basename("c.pdf"), "c.pdf");
        assert_eq!(basename(""), "");
    }
}
