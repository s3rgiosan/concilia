//! Checks the Rust port against outputs of the original Node implementation, recorded in
//! `tests/fixtures/golden/` from fabricated inputs.

use std::path::PathBuf;

use concilia_lib::bank_fees::is_bank_fee;
use concilia_lib::gemini::parse::parse_json_from_text;
use concilia_lib::matcher::match_transactions;
use concilia_lib::model::{ReceiptMeta, Rule, StatementTransaction};
use concilia_lib::schema::{ddmmyyyy_to_iso, euro_str_to_cents, euros_to_cents};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct Case<I, E> {
    input: I,
    expected: E,
}

fn cases<I: for<'de> Deserialize<'de>, E: for<'de> Deserialize<'de>>(
    name: &str,
) -> Vec<Case<I, E>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/golden")
        .join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[derive(Deserialize)]
struct MatcherInput {
    transactions: Vec<StatementTransaction>,
    receipts: Vec<ReceiptMeta>,
    rules: Vec<Rule>,
}

#[test]
fn matcher_matches_the_node_implementation() {
    let cases: Vec<Case<MatcherInput, Value>> = cases("matcher");
    assert!(!cases.is_empty());
    for (i, case) in cases.iter().enumerate() {
        let input = &case.input;
        let actual = serde_json::to_value(match_transactions(
            &input.transactions,
            &input.receipts,
            &input.rules,
        ))
        .unwrap();
        assert_eq!(actual, case.expected, "matcher case {i}");
    }
}

#[test]
fn bank_fees_match_the_node_implementation() {
    for case in cases::<String, bool>("bank_fees") {
        assert_eq!(is_bank_fee(&case.input), case.expected, "{:?}", case.input);
    }
}

#[test]
fn euro_rounding_matches_the_node_implementation() {
    for case in cases::<f64, i64>("euros_to_cents") {
        assert_eq!(euros_to_cents(case.input), case.expected, "{}", case.input);
    }
}

#[test]
fn euro_strings_match_the_node_implementation() {
    for case in cases::<String, i64>("euro_str_to_cents") {
        assert_eq!(
            euro_str_to_cents(&case.input),
            Ok(case.expected),
            "{:?}",
            case.input
        );
    }
}

#[test]
fn date_conversion_matches_the_node_implementation() {
    for case in cases::<String, Option<String>>("ddmmyyyy_to_iso") {
        assert_eq!(
            ddmmyyyy_to_iso(&case.input).ok(),
            case.expected,
            "{:?}",
            case.input
        );
    }
}

#[test]
fn gemini_reply_parsing_matches_the_node_implementation() {
    for case in cases::<String, Value>("gemini_parse") {
        let actual = parse_json_from_text(&case.input).map(|e| {
            json!({
                "amount_cents": e.amount_cents,
                "confidence": "high",
                "currency": e.currency,
                "vendor": e.vendor,
                "date": e.date,
            })
        });
        assert_eq!(
            actual.unwrap_or(Value::Null),
            case.expected,
            "{:?}",
            case.input
        );
    }
}
