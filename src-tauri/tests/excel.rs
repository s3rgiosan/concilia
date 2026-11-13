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

/// Cell texts and sheet names the report words differently from the Node implementation.
fn renamed(lang: Language) -> &'static [(&'static str, &'static str)] {
    match lang {
        Language::En => &[
            ("Validated", "All Transactions"),
            ("Review", "Needs Review"),
            ("Label", "Category"),
            ("Bank fee (auto)", "Bank Fee"),
            ("No receipt", "Other"),
        ],
        Language::Pt => &[
            ("Validados", "Todas as transações"),
            ("Revisão", "Por rever"),
            ("Sem Associação", "Sem associação"),
            ("Comissão bancária (auto)", "Comissão bancária"),
            ("Sem recibo", "Outro"),
            ("Data da Transação", "Data da transação"),
            ("Descrição da Transação", "Descrição da transação"),
            ("Valor da Transação", "Valor da transação"),
            ("Ficheiro do Recibo", "Ficheiro do recibo"),
            ("Valor do Recibo", "Valor do recibo"),
            ("Confiança do Recibo", "Confiança do recibo"),
            ("Moeda do Recibo", "Moeda do recibo"),
        ],
    }
}

/// Phrases inside notes that the report words differently from the Node implementation.
fn renamed_phrases(lang: Language) -> &'static [(&'static str, &'static str)] {
    match lang {
        Language::En => &[
            ("FX match (", "Foreign-currency match ("),
            ("FX receipt within", "foreign-currency receipt within"),
            ("FX receipts within", "foreign-currency receipts within"),
        ],
        Language::Pt => &[
            ("Regra de correspondência (", "Regra de associação ("),
            (
                "Correspondência FX (",
                "Correspondência em moeda estrangeira (",
            ),
            ("recibo FX dentro", "recibo em moeda estrangeira dentro"),
            ("recibos FX dentro", "recibos em moeda estrangeira dentro"),
        ],
    }
}

fn rename_text(text: &str, lang: Language) -> String {
    if let Some((_, new)) = renamed(lang).iter().find(|(old, _)| *old == text) {
        return (*new).to_string();
    }
    renamed_phrases(lang)
        .iter()
        .fold(text.to_string(), |acc, (old, new)| acc.replace(old, new))
}

/// The fixture's sheets with the labels the report uses now. A column whose cells changed
/// gets the width the report derives from its longest cell.
fn with_current_labels(expected: &Value, lang: Language) -> Value {
    let mut sheets = expected.clone();
    for sheet in sheets.as_array_mut().unwrap() {
        let name = rename_text(sheet["name"].as_str().unwrap(), lang);
        sheet["name"] = json!(name);
        let columns = sheet["widths"].as_array().unwrap().len();
        let mut changed = vec![false; columns];
        for row in sheet["rows"].as_array_mut().unwrap() {
            for (c, cell) in row.as_array_mut().unwrap().iter_mut().enumerate() {
                if cell["number"] == json!(false) {
                    let old = cell["value"].as_str().unwrap().to_string();
                    let new = rename_text(&old, lang);
                    if new != old {
                        changed[c] = true;
                        cell["value"] = json!(new);
                    }
                }
            }
        }
        for c in (0..columns).filter(|c| changed[*c]) {
            let longest = sheet["rows"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| {
                    let cell = &row[c];
                    match cell["value"].as_str() {
                        Some(text) => text.encode_utf16().count(),
                        None => cell["value"].as_f64().unwrap_or(0.0).to_string().len(),
                    }
                })
                .max()
                .unwrap_or(0);
            sheet["widths"][c] = json!((longest + 2).clamp(10, 50));
        }
    }
    sheets
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
        let expected = with_current_labels(&case.expected, case.input.lang);
        if let Some(difference) = first_difference(String::new(), &actual, &expected) {
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
