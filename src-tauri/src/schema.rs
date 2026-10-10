//! Conversions from parser output to the canonical transaction schema: ISO dates and signed
//! integer cents.

use crate::model::{RawTransaction, StatementTransaction, Status};
use crate::text::js_round;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum SchemaError {
    #[error("invalid date format (expected DD/MM/YYYY): {0}")]
    Date(String),
    #[error("invalid amount: {0}")]
    Amount(String),
}

/// Converts `DD/MM/YYYY` to `YYYY-MM-DD`.
pub fn ddmmyyyy_to_iso(value: &str) -> Result<String, SchemaError> {
    let bytes = value.as_bytes();
    let shape_ok = bytes.len() == 10
        && bytes[2] == b'/'
        && bytes[5] == b'/'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 2 || i == 5 || b.is_ascii_digit());
    if !shape_ok {
        return Err(SchemaError::Date(value.to_string()));
    }
    Ok(format!(
        "{}-{}-{}",
        &value[6..10],
        &value[3..5],
        &value[0..2]
    ))
}

/// Converts a European decimal string such as `1.234,56` or `-45,99` to signed cents.
///
/// `.` separates thousands and `,` the decimals. Up to two decimal places are exact; further
/// places round half away from zero. An empty string is zero.
pub fn euro_str_to_cents(value: &str) -> Result<i64, SchemaError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(0);
    }
    let invalid = || SchemaError::Amount(value.to_string());
    let (negative, unsigned) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed),
    };
    let digits: String = unsigned.chars().filter(|c| *c != '.').collect();
    let (whole, fraction) = match digits.split_once(',') {
        Some((whole, fraction)) => (whole, fraction),
        None => (digits.as_str(), ""),
    };
    let all_digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if (whole.is_empty() && fraction.is_empty()) || !all_digits(whole) || !all_digits(fraction) {
        return Err(invalid());
    }
    let whole: i64 = if whole.is_empty() {
        0
    } else {
        whole.parse().map_err(|_| invalid())?
    };
    let mut fraction_digits = fraction.bytes().map(|b| i64::from(b - b'0'));
    let tenths = fraction_digits.next().unwrap_or(0);
    let hundredths = fraction_digits.next().unwrap_or(0);
    let round_up = fraction_digits.next().is_some_and(|d| d >= 5);
    let cents = whole
        .checked_mul(100)
        .and_then(|c| c.checked_add(tenths * 10 + hundredths + i64::from(round_up)))
        .ok_or_else(invalid)?;
    Ok(if negative { -cents } else { cents })
}

/// Rounds `euros * 100` to cents the way JavaScript's `Math.round` does: halves toward
/// positive infinity.
pub fn euros_to_cents(euros: f64) -> i64 {
    js_round(euros * 100.0) as i64
}

/// Builds the deterministic transaction ID `tx-<index padded to 3>-<date>-<cents>`.
fn make_transaction_id(index: usize, iso_date: &str, amount_cents: i64) -> String {
    format!("tx-{index:03}-{iso_date}-{amount_cents}")
}

/// Converts one parser line to the canonical schema. `index` is 1-based within its statement.
pub fn normalize_transaction(
    raw: &RawTransaction,
    index: usize,
) -> Result<StatementTransaction, SchemaError> {
    let date = ddmmyyyy_to_iso(&raw.date)?;
    let description = if raw.description.is_empty() {
        "Unknown".to_string()
    } else {
        raw.description.clone()
    };
    Ok(StatementTransaction {
        id: make_transaction_id(index, &date, raw.amount_cents),
        date,
        description,
        amount_cents: raw.amount_cents,
        abs_cents: raw.amount_cents.abs(),
        status: Status::Unmatched,
        extra: Default::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_ddmmyyyy_to_iso() {
        assert_eq!(ddmmyyyy_to_iso("15/01/2030").unwrap(), "2030-01-15");
        assert_eq!(ddmmyyyy_to_iso("01/12/2029").unwrap(), "2029-12-01");
        assert_eq!(ddmmyyyy_to_iso("31/07/2028").unwrap(), "2028-07-31");
    }

    #[test]
    fn rejects_other_date_formats() {
        for value in ["2030-01-15", "1/1/2030", "", "15/01/30", "15-01-2030"] {
            assert!(ddmmyyyy_to_iso(value).is_err(), "{value}");
        }
    }

    #[test]
    fn converts_european_decimal_strings_to_cents() {
        assert_eq!(euro_str_to_cents("1.234,56").unwrap(), 123_456);
        assert_eq!(euro_str_to_cents("-45,99").unwrap(), -4599);
        assert_eq!(euro_str_to_cents("50,00").unwrap(), 5000);
        assert_eq!(euro_str_to_cents("12.345.678,90").unwrap(), 1_234_567_890);
        assert_eq!(euro_str_to_cents("0,50").unwrap(), 50);
        assert_eq!(euro_str_to_cents("  45,99  ").unwrap(), 4599);
        assert_eq!(euro_str_to_cents("10").unwrap(), 1000);
        assert_eq!(euro_str_to_cents("10,5").unwrap(), 1050);
    }

    #[test]
    fn treats_blank_amounts_as_zero() {
        assert_eq!(euro_str_to_cents("").unwrap(), 0);
        assert_eq!(euro_str_to_cents("   ").unwrap(), 0);
        assert_eq!(euro_str_to_cents("0,00").unwrap(), 0);
    }

    #[test]
    fn rounds_extra_decimal_places_half_away_from_zero() {
        assert_eq!(euro_str_to_cents("1,005").unwrap(), 101);
        assert_eq!(euro_str_to_cents("1,004").unwrap(), 100);
        assert_eq!(euro_str_to_cents("-1,005").unwrap(), -101);
    }

    #[test]
    fn rejects_malformed_amounts() {
        for value in ["abc", "1,2,3", "-", ",", "1 000,00", "--1,00"] {
            assert!(euro_str_to_cents(value).is_err(), "{value}");
        }
    }

    #[test]
    fn rounds_euros_like_math_round() {
        assert_eq!(euros_to_cents(-45.99), -4599);
        assert_eq!(euros_to_cents(50.0), 5000);
        assert_eq!(euros_to_cents(0.0), 0);
        assert_eq!(euros_to_cents(1234.56), 123_456);
        assert_eq!(euros_to_cents(0.1 + 0.2), 30);
        assert_eq!(euros_to_cents(-0.005), 0);
        assert_eq!(euros_to_cents(0.025), 3);
        assert_eq!(euros_to_cents(-0.025), -2);
    }

    #[test]
    fn makes_deterministic_ids() {
        assert_eq!(
            make_transaction_id(1, "2030-01-15", -4599),
            "tx-001-2030-01-15--4599"
        );
        assert_eq!(
            make_transaction_id(42, "2029-12-01", 5000),
            "tx-042-2029-12-01-5000"
        );
        assert!(make_transaction_id(100, "2030-01-01", 0).starts_with("tx-100-"));
    }

    #[test]
    fn normalizes_parser_output() {
        let raw = RawTransaction {
            date: "15/01/2030".into(),
            description: "COMPRA LOJA".into(),
            amount_cents: -4599,
        };
        let tx = normalize_transaction(&raw, 1).unwrap();
        assert_eq!(tx.id, "tx-001-2030-01-15--4599");
        assert_eq!(tx.date, "2030-01-15");
        assert_eq!(tx.description, "COMPRA LOJA");
        assert_eq!(tx.amount_cents, -4599);
        assert_eq!(tx.abs_cents, 4599);
        assert_eq!(tx.status, Status::Unmatched);
    }

    #[test]
    fn defaults_an_empty_description_to_unknown() {
        let raw = RawTransaction {
            date: "01/01/2030".into(),
            description: String::new(),
            amount_cents: 1000,
        };
        assert_eq!(
            normalize_transaction(&raw, 1).unwrap().description,
            "Unknown"
        );
    }

    #[test]
    fn keeps_credits_positive() {
        let raw = RawTransaction {
            date: "01/01/2030".into(),
            description: "DEPOSIT".into(),
            amount_cents: 10_050,
        };
        let tx = normalize_transaction(&raw, 1).unwrap();
        assert_eq!(tx.amount_cents, 10_050);
        assert_eq!(tx.abs_cents, 10_050);
    }
}
