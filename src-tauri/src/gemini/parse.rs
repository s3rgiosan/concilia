//! Reads the receipt fields out of Gemini's reply text.

use serde_json::Value;

use crate::dates::epoch_days;
use crate::schema::euros_to_cents;
use crate::text::{js_len, js_trim};

/// The fields Gemini read from a receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extracted {
    /// Always positive.
    pub amount_cents: i64,
    pub currency: Option<String>,
    pub vendor: Option<String>,
    /// ISO 8601 issue date.
    pub date: Option<String>,
}

/// Parses `{ amount, currency, vendor, date }` from the reply, which may wrap the JSON in
/// other text such as a Markdown code block. Returns none for an `error` reply or when the
/// amount is not a number.
pub fn parse_json_from_text(text: &str) -> Option<Extracted> {
    if text.is_empty() {
        return None;
    }
    let data: Value = serde_json::from_str(text).ok().or_else(|| {
        let start = text.find('{')?;
        let end = text.rfind('}')?;
        (end > start)
            .then(|| serde_json::from_str(&text[start..=end]).ok())
            .flatten()
    })?;
    let object = data.as_object()?;
    if object.get("error").is_some_and(is_truthy) {
        return None;
    }
    let amount = object.get("amount")?.as_f64()?;

    let currency = object
        .get("currency")
        .and_then(Value::as_str)
        .and_then(|raw| normalize_currency(js_trim(raw)));
    let vendor = object
        .get("vendor")
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let date = object
        .get("date")
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|d| epoch_days(d).is_some())
        .map(str::to_string);

    Some(Extracted {
        amount_cents: euros_to_cents(amount).abs(),
        currency,
        vendor,
        date,
    })
}

fn normalize_currency(raw: &str) -> Option<String> {
    match raw {
        "$" => Some("USD".into()),
        "€" => Some("EUR".into()),
        "£" => Some("GBP".into()),
        "¥" => Some("JPY".into()),
        "R$" => Some("BRL".into()),
        _ if js_len(raw) == 3 => Some(raw.to_uppercase()),
        _ => None,
    }
}

/// JavaScript truthiness of a JSON value.
fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extracted(amount_cents: i64, currency: Option<&str>) -> Extracted {
        Extracted {
            amount_cents,
            currency: currency.map(str::to_string),
            vendor: None,
            date: None,
        }
    }

    #[test]
    fn parses_clean_json() {
        assert_eq!(
            parse_json_from_text(r#"{"amount": 12.50, "currency": "EUR"}"#),
            Some(extracted(1250, Some("EUR")))
        );
        assert_eq!(
            parse_json_from_text(r#"{"amount": 12.50}"#),
            Some(extracted(1250, None))
        );
    }

    #[test]
    fn parses_wrapped_json() {
        assert_eq!(
            parse_json_from_text("```json\n{\"amount\": 45.99, \"currency\": \"USD\"}\n```"),
            Some(extracted(4599, Some("USD")))
        );
        assert_eq!(
            parse_json_from_text(r#"The total is {"amount": 10.00, "currency": "GBP"}"#),
            Some(extracted(1000, Some("GBP")))
        );
    }

    #[test]
    fn rejects_errors_and_missing_amounts() {
        assert_eq!(parse_json_from_text(r#"{"error": "unreadable"}"#), None);
        assert_eq!(parse_json_from_text(r#"{"amount": "twelve"}"#), None);
        assert_eq!(parse_json_from_text(""), None);
        assert_eq!(parse_json_from_text("null"), None);
        assert_eq!(parse_json_from_text("[1, 2]"), None);
        assert_eq!(parse_json_from_text("no json here"), None);
    }

    #[test]
    fn ignores_a_falsy_error_field() {
        assert_eq!(
            parse_json_from_text(r#"{"error": "", "amount": 1}"#),
            Some(extracted(100, None))
        );
    }

    #[test]
    fn keeps_zero_amounts() {
        assert_eq!(
            parse_json_from_text(r#"{"amount": 0}"#)
                .unwrap()
                .amount_cents,
            0
        );
    }

    #[test]
    fn makes_negative_amounts_positive() {
        assert_eq!(
            parse_json_from_text(r#"{"amount": -12.50, "currency": "EUR"}"#),
            Some(extracted(1250, Some("EUR")))
        );
        assert_eq!(
            parse_json_from_text(r#"{"amount": -99.99}"#),
            Some(extracted(9999, None))
        );
    }

    #[test]
    fn normalizes_currencies() {
        let currency = |json: &str| parse_json_from_text(json).unwrap().currency;
        assert_eq!(
            currency(r#"{"amount": 1, "currency": "eur"}"#).as_deref(),
            Some("EUR")
        );
        assert_eq!(currency(r#"{"amount": 1, "currency": "EURO"}"#), None);
        assert_eq!(
            currency(r#"{"amount": 1, "currency": " € "}"#).as_deref(),
            Some("EUR")
        );
        assert_eq!(
            currency(r#"{"amount": 1, "currency": "R$"}"#).as_deref(),
            Some("BRL")
        );
        assert_eq!(currency(r#"{"amount": 1, "currency": 978}"#), None);
    }

    #[test]
    fn keeps_trimmed_vendors() {
        let vendor = |json: &str| parse_json_from_text(json).unwrap().vendor;
        assert_eq!(
            vendor(r#"{"amount": 1, "vendor": "  ACME CORP "}"#).as_deref(),
            Some("ACME CORP")
        );
        assert_eq!(vendor(r#"{"amount": 1, "vendor": "   "}"#), None);
    }

    #[test]
    fn keeps_only_iso_dates() {
        let date = |json: &str| parse_json_from_text(json).unwrap().date;
        assert_eq!(
            date(r#"{"amount": 10.00, "date": "2030-11-14"}"#).as_deref(),
            Some("2030-11-14")
        );
        assert_eq!(date(r#"{"amount": 10.00, "date": "14/11/2030"}"#), None);
        assert_eq!(date(r#"{"amount": 10.00, "date": "2030-13-99"}"#), None);
        assert_eq!(date(r#"{"amount": 10.00}"#), None);
        assert_eq!(date(r#"{"amount": 10.00, "date": null}"#), None);
    }
}
