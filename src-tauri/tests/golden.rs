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

/// Whether a receipt's amount fits a transaction the way a rule hit requires: exactly for EUR
/// or an unknown currency, within ±10% for a foreign currency.
fn rule_amount_fits(receipt: &Value, abs_cents: i64) -> bool {
    let Some(cents) = receipt["amount_cents"].as_i64() else {
        return false;
    };
    match receipt["currency"].as_str() {
        None | Some("EUR") => cents == abs_cents,
        Some(_) => {
            let lo = (abs_cents * 90 + 99) / 100;
            let hi = abs_cents * 110 / 100;
            (lo..=hi).contains(&cents)
        }
    }
}

/// Whether Node settled a transaction by a rule with a receipt whose amount does not fit.
/// Rust sends those to REVIEW (see DIFFERENCES.md), and every later pass differs with them.
fn has_rule_hit_without_amount(expected: &Value) -> bool {
    expected["transactions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|tx| tx["notes"].as_str().unwrap().starts_with("rule_match ("))
        .any(|tx| {
            let abs_cents = tx["abs_cents"].as_i64().unwrap();
            tx["receipt_meta"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| !rule_amount_fits(r, abs_cents))
        })
}

/// Node's result with the REVIEW candidates removed that a MATCHED transaction took, as the
/// Rust matcher does at its end (see DIFFERENCES.md).
fn without_taken_candidates(expected: &Value) -> Value {
    let mut result = expected.clone();
    let taken: Vec<String> = result["transactions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|tx| tx["status"] == "MATCHED")
        .flat_map(|tx| tx["receipt_files"].as_array().unwrap().iter())
        .map(|f| f.as_str().unwrap().to_string())
        .collect();
    let mut changed = false;
    for tx in result["transactions"].as_array_mut().unwrap() {
        if tx["status"] != "REVIEW" {
            continue;
        }
        let kept: Vec<Value> = tx["receipt_meta"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| !taken.contains(&r["file"].as_str().unwrap().to_string()))
            .cloned()
            .collect();
        if kept.len() != tx["receipt_meta"].as_array().unwrap().len() {
            changed = true;
            tx["receipt_files"] = json!(kept.iter().map(|r| r["file"].clone()).collect::<Vec<_>>());
            tx["receipt_meta"] = json!(kept);
            if kept.is_empty() {
                tx["status"] = json!("UNMATCHED");
                tx["notes"] = json!("");
            } else {
                let notes = tx["notes"].as_str().unwrap();
                let digits = notes.chars().take_while(char::is_ascii_digit).count();
                if digits > 0 && notes[digits..].starts_with(' ') {
                    tx["notes"] = json!(format!("{}{}", kept.len(), &notes[digits..]));
                }
            }
        }
    }
    if changed {
        // Every review file keeps Node's order; files no REVIEW transaction holds drop out.
        let held: Vec<Value> = result["transactions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|tx| tx["status"] == "REVIEW")
            .flat_map(|tx| tx["receipt_files"].as_array().unwrap().clone())
            .collect();
        let review: Vec<Value> = result["receiptsByStatus"]["review"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|f| held.contains(f))
            .cloned()
            .collect();
        result["receiptsByStatus"]["review"] = json!(review);
    }
    result
}

#[test]
fn matcher_matches_the_node_implementation() {
    let cases: Vec<Case<MatcherInput, Value>> = cases("matcher");
    assert!(!cases.is_empty());
    let mut compared = 0;
    for (i, case) in cases.iter().enumerate() {
        let input = &case.input;
        let actual = serde_json::to_value(match_transactions(
            &input.transactions,
            &input.receipts,
            &input.rules,
        ))
        .unwrap();
        if has_rule_hit_without_amount(&case.expected) {
            // Rust's rule hits always fit the amount, or are REVIEW with `rule_match_amount`.
            for tx in actual["transactions"].as_array().unwrap() {
                let notes = tx["notes"].as_str().unwrap();
                let abs_cents = tx["abs_cents"].as_i64().unwrap();
                let receipts = tx["receipt_meta"].as_array().unwrap();
                if notes.starts_with("rule_match (") {
                    assert!(
                        receipts.iter().all(|r| rule_amount_fits(r, abs_cents)),
                        "matcher case {i}: {tx}"
                    );
                }
                if notes.starts_with("rule_match_amount (") {
                    assert_eq!(tx["status"], "REVIEW", "matcher case {i}");
                    assert!(
                        receipts.iter().all(|r| !rule_amount_fits(r, abs_cents)),
                        "matcher case {i}: {tx}"
                    );
                }
            }
            continue;
        }
        assert_eq!(
            actual,
            without_taken_candidates(&case.expected),
            "matcher case {i}"
        );
        compared += 1;
    }
    assert!(
        compared >= cases.len() - 20,
        "only {compared} cases compared"
    );
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

#[test]
fn prompts_match_the_node_implementation() {
    let prompts: Vec<Case<String, String>> = cases("prompts");
    for case in prompts {
        let actual = match case.input.as_str() {
            "receipt" => concilia_lib::gemini::prompt::RECEIPT_PROMPT,
            "retry" => concilia_lib::gemini::prompt::RETRY_PROMPT,
            other => panic!("unknown prompt {other}"),
        };
        assert_eq!(actual, case.expected, "{} prompt", case.input);
    }
}
