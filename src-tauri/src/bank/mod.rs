//! Bank statement parsers and their normalization to canonical transactions.

pub mod cgd;

use std::collections::{HashMap, HashSet};
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::model::{RawTransaction, StatementTransaction};
use crate::schema::{normalize_transaction, SchemaError};

/// A bank whose statements Concilia can parse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Bank {
    Cgd,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("unknown bank: {0}")]
pub struct UnknownBank(pub String);

impl FromStr for Bank {
    type Err = UnknownBank;

    fn from_str(value: &str) -> Result<Bank, UnknownBank> {
        match value.to_ascii_lowercase().as_str() {
            "cgd" => Ok(Bank::Cgd),
            _ => Err(UnknownBank(value.to_string())),
        }
    }
}

impl Bank {
    /// Parses the `pdftotext -layout` text of one statement.
    pub fn parse_text(self, text: &str) -> Vec<RawTransaction> {
        match self {
            Bank::Cgd => cgd::parse_text(text),
        }
    }
}

/// Canonical transactions parsed from a batch of statements.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Normalized {
    pub transactions: Vec<StatementTransaction>,
    /// How many transactions each statement contributed, in the order given.
    pub counts: Vec<usize>,
}

/// Normalizes the transactions of several statements and drops repeated IDs, keeping the
/// first. Indexes restart at 1 for each statement.
pub fn normalize_statements(statements: &[Vec<RawTransaction>]) -> Result<Normalized, SchemaError> {
    let mut seen = HashSet::new();
    let mut out = Normalized::default();
    for statement in statements {
        let mut count = 0;
        for (i, raw) in statement.iter().enumerate() {
            let tx = normalize_transaction(raw, i + 1)?;
            if seen.insert(tx.id.clone()) {
                out.transactions.push(tx);
                count += 1;
            }
        }
        out.counts.push(count);
    }
    Ok(out)
}

/// What one added statement contributed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StatementCount {
    pub added: usize,
    /// Rows whose date, amount and description were already present.
    pub skipped: usize,
}

/// New transactions from statements added to a period that already holds `existing`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Appended {
    pub transactions: Vec<StatementTransaction>,
    /// One entry per statement, in the order given.
    pub counts: Vec<StatementCount>,
}

/// The index part of a `tx-<index>-<date>-<cents>` ID.
fn id_index(id: &str) -> Option<usize> {
    id.strip_prefix("tx-")?.split('-').next()?.parse().ok()
}

/// Normalizes statements added to a period. New transactions are numbered after the highest
/// index in `existing`, one sequence across the whole batch, so no ID can repeat. A row is a
/// duplicate while its date, amount and description occur no more often in the statement so
/// far than they already did in the period (existing transactions plus earlier statements of
/// the batch). Identical rows within one statement stay distinct transactions, and a statement
/// added twice contributes nothing the second time.
pub fn append_statements(
    existing: &[StatementTransaction],
    statements: &[Vec<RawTransaction>],
) -> Result<Appended, SchemaError> {
    type Key = (String, i64, String);
    let key = |tx: &StatementTransaction| -> Key {
        (tx.date.clone(), tx.amount_cents, tx.description.clone())
    };
    let mut present: HashMap<Key, usize> = HashMap::new();
    for tx in existing {
        *present.entry(key(tx)).or_default() += 1;
    }
    let mut next = existing
        .iter()
        .filter_map(|tx| id_index(&tx.id))
        .max()
        .unwrap_or(0)
        + 1;

    let mut out = Appended::default();
    for statement in statements {
        let before = present.clone();
        let mut seen_here: HashMap<Key, usize> = HashMap::new();
        let mut count = StatementCount::default();
        for raw in statement {
            let tx = normalize_transaction(raw, next)?;
            let k = key(&tx);
            let occurrence = seen_here.entry(k.clone()).or_default();
            *occurrence += 1;
            let already = before.get(&k).copied().unwrap_or(0);
            if *occurrence <= already {
                count.skipped += 1;
                continue;
            }
            next += 1;
            *present.entry(k).or_default() += 1;
            out.transactions.push(tx);
            count.added += 1;
        }
        out.counts.push(count);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(date: &str, description: &str, amount_cents: i64) -> RawTransaction {
        RawTransaction {
            date: date.into(),
            description: description.into(),
            amount_cents,
        }
    }

    #[test]
    fn parses_bank_keys_case_insensitively() {
        assert_eq!("cgd".parse::<Bank>(), Ok(Bank::Cgd));
        assert_eq!("CGD".parse::<Bank>(), Ok(Bank::Cgd));
        assert_eq!("acme".parse::<Bank>(), Err(UnknownBank("acme".into())));
    }

    #[test]
    fn indexes_each_statement_from_one_and_drops_repeated_ids() {
        let first = vec![
            raw("01/03/2030", "ACME CORP", -1000),
            raw("02/03/2030", "EXAMPLE FEE", -100),
        ];
        let second = vec![
            raw("01/03/2030", "ACME CORP", -1000),
            raw("05/03/2030", "ACME CORP", -2000),
        ];
        let normalized = normalize_statements(&[first, second]).unwrap();
        assert_eq!(normalized.counts, [2, 1]);
        let ids: Vec<_> = normalized
            .transactions
            .iter()
            .map(|t| t.id.as_str())
            .collect();
        assert_eq!(
            ids,
            [
                "tx-001-2030-03-01--1000",
                "tx-002-2030-03-02--100",
                "tx-002-2030-03-05--2000"
            ]
        );
    }

    fn existing(ids: &[(&str, &str, &str, i64)]) -> Vec<StatementTransaction> {
        ids.iter()
            .map(
                |(id, date, description, amount_cents)| StatementTransaction {
                    id: (*id).into(),
                    date: (*date).into(),
                    description: (*description).into(),
                    amount_cents: *amount_cents,
                    abs_cents: amount_cents.abs(),
                    status: Default::default(),
                    extra: Default::default(),
                },
            )
            .collect()
    }

    #[test]
    fn appends_after_the_highest_index_and_skips_rows_already_present() {
        let period = existing(&[
            ("tx-001-2030-03-01--1000", "2030-03-01", "ACME CORP", -1000),
            ("tx-007-2030-03-02--100", "2030-03-02", "EXAMPLE FEE", -100),
        ]);
        let statement = vec![
            raw("02/03/2030", "EXAMPLE FEE", -100),
            raw("09/03/2030", "GLOBEX", -2000),
            raw("09/03/2030", "GLOBEX", -2000),
        ];
        let appended = append_statements(&period, &[statement.clone(), statement]).unwrap();
        let ids: Vec<_> = appended
            .transactions
            .iter()
            .map(|t| t.id.as_str())
            .collect();
        assert_eq!(ids, ["tx-008-2030-03-09--2000", "tx-009-2030-03-09--2000"]);
        assert_eq!(
            appended.counts,
            [
                StatementCount {
                    added: 2,
                    skipped: 1
                },
                StatementCount {
                    added: 0,
                    skipped: 3
                }
            ]
        );
    }

    #[test]
    fn appends_from_one_for_a_period_without_numbered_ids() {
        let appended =
            append_statements(&[], &[vec![raw("01/03/2030", "ACME CORP", -1000)]]).unwrap();
        assert_eq!(appended.transactions[0].id, "tx-001-2030-03-01--1000");
    }
}
