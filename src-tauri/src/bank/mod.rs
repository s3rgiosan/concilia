//! Bank statement parsers and their normalization to canonical transactions.

pub mod cgd;

use std::collections::HashSet;
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

/// Normalizes the transactions of several statements and drops repeated IDs, keeping the
/// first. Indexes restart at 1 for each statement.
pub fn normalize_statements(
    statements: &[Vec<RawTransaction>],
) -> Result<Vec<StatementTransaction>, SchemaError> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for statement in statements {
        for (i, raw) in statement.iter().enumerate() {
            let tx = normalize_transaction(raw, i + 1)?;
            if seen.insert(tx.id.clone()) {
                out.push(tx);
            }
        }
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
        let txs = normalize_statements(&[first, second]).unwrap();
        let ids: Vec<_> = txs.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "tx-001-2030-03-01--1000",
                "tx-002-2030-03-02--100",
                "tx-002-2030-03-05--2000"
            ]
        );
    }
}
