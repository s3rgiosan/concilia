//! The Excel report: sheet layout against the Node implementation's output, and the written
//! file read back. The fixtures hold the Node labels; `with_current_labels` maps them to the
//! report's current wording (see DIFFERENCES.md).

use std::path::PathBuf;

use calamine::{open_workbook, Data, Reader, Xlsx};
use concilia_lib::excel::{build, write, CellValue, Labels, Sheet};
use concilia_lib::model::{default_reasons, Language, MatchResult, ReceiptMeta};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct Input {
    result: MatchResult,
    reimbursements: Vec<ReceiptMeta>,
    lang: Language,
}

#[derive(Deserialize)]
struct Case {
    input: Input,
    expected: Value,
}

fn cases() -> Vec<Case> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/golden/excel.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The sheets in the fixture's shape.
fn as_fixture(sheets: &[Sheet]) -> Value {
    Value::Array(
        sheets
            .iter()
            .map(|sheet| {
                let rows: Vec<Value> = sheet
                    .rows
                    .iter()
                    .map(|row| {
                        row.iter()
                            .map(|cell| {
                                let (value, number) = match &cell.value {
                                    CellValue::Text(text) => (json!(text), false),
                                    CellValue::Number(n) => (json!(n), true),
                                };
                                json!({
                                    "value": value,
                                    "number": number,
                                    "bold": cell.bold,
                                    "background": cell.background,
                                    "format": cell.number_format,
                                })
                            })
                            .collect()
                    })
                    .collect();
                json!({ "name": sheet.name, "widths": sheet.widths, "rows": rows })
            })
            .collect(),
    )
}

/// The first place two JSON values differ, as a path with both values.
fn first_difference(path: String, a: &Value, b: &Value) -> Option<String> {
    match (a, b) {
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => x
            .iter()
            .zip(y)
            .enumerate()
            .find_map(|(i, (p, q))| first_difference(format!("{path}[{i}]"), p, q)),
        (Value::Object(x), Value::Object(y)) if x.len() == y.len() => {
            x.iter().find_map(|(k, v)| {
                first_difference(format!("{path}.{k}"), v, y.get(k).unwrap_or(&Value::Null))
            })
        }
        (Value::Number(x), Value::Number(y)) if x.as_f64() == y.as_f64() => None,
        _ if a == b => None,
        _ => Some(format!("{path}: {a} != {b}")),
    }
}

#[test]
fn sheets_match_the_node_implementation() {
    let cases = cases();
    assert!(!cases.is_empty());
    for (i, case) in cases.iter().enumerate() {
        let sheets = build(
            &case.input.result,
            &case.input.reimbursements,
            &Labels {
                language: case.input.lang,
                reasons: &default_reasons(),
            },
        );
        let actual = as_fixture(&sheets);
        if let Some(difference) = first_difference(String::new(), &actual, &case.expected) {
            panic!("excel case {i}: {difference}");
        }
    }
}

#[test]
fn written_files_read_back_with_the_same_cells() {
    let dir = tempfile::tempdir().unwrap();
    for (i, case) in cases().iter().enumerate().take(10) {
        let sheets = build(
            &case.input.result,
            &case.input.reimbursements,
            &Labels {
                language: case.input.lang,
                reasons: &default_reasons(),
            },
        );
        let path = dir.path().join(format!("report-{i}.xlsx"));
        write(&sheets, &path).unwrap();

        let mut workbook: Xlsx<_> = open_workbook(&path).unwrap();
        let names: Vec<String> = sheets.iter().map(|s| s.name.clone()).collect();
        assert_eq!(workbook.sheet_names(), names, "case {i}");
        for sheet in &sheets {
            let range = workbook.worksheet_range(&sheet.name).unwrap();
            for (r, row) in sheet.rows.iter().enumerate() {
                for (c, cell) in row.iter().enumerate() {
                    let read = range
                        .get_value((r as u32, c as u32))
                        .cloned()
                        .unwrap_or(Data::Empty);
                    match &cell.value {
                        CellValue::Text(text) if text.is_empty() => assert_eq!(read, Data::Empty),
                        CellValue::Text(text) => {
                            assert_eq!(read, Data::String(text.clone()), "{} {r},{c}", sheet.name)
                        }
                        CellValue::Number(n) => {
                            assert_eq!(read, Data::Float(*n), "{} {r},{c}", sheet.name)
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn reimbursements_sheet_only_when_there_are_any() {
    let result = MatchResult::default();
    let names = |sheets: Vec<Sheet>| sheets.into_iter().map(|s| s.name).collect::<Vec<_>>();
    assert_eq!(
        names(build(
            &result,
            &[],
            &Labels {
                language: Language::En,
                reasons: &default_reasons(),
            }
        )),
        [
            "Totals",
            "All Transactions",
            "Matched",
            "Needs Review",
            "Unmatched"
        ]
    );
    let taxi = ReceiptMeta {
        file: "/receipts/2030/03/reimbursements/taxi.pdf".into(),
        amount_cents: Some(1000),
        ..Default::default()
    };
    assert_eq!(
        names(build(
            &result,
            &[taxi],
            &Labels {
                language: Language::Pt,
                reasons: &default_reasons(),
            }
        )),
        [
            "Totais",
            "Todas as transações",
            "Associados",
            "Por rever",
            "Sem associação",
            "Reembolsos"
        ]
    );
}
