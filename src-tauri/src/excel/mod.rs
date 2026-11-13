//! The Excel report.
//!
//! Sheets, in order: Totals, All Transactions, Matched and Needs Review (one row per
//! receipt of a MATCHED or REVIEW transaction), Unmatched (receipts no transaction uses), and
//! Reimbursements when there are any. [`build`] lays the sheets out as data; [`write`] saves
//! them as `.xlsx`.

pub mod strings;

use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use rust_xlsxwriter::{Color, Format, Workbook, XlsxError};

use crate::model::{
    basename, is_other_reason, is_reason_id, reason_label, Language, MatchResult, Reason,
    ReceiptMeta, Status, Transaction,
};
use crate::text::js_len;
use strings::{strings, Strings};

const MONEY_FORMAT: &str = "#,##0.00";
const MIN_WIDTH: usize = 10;
const MAX_WIDTH: usize = 50;

#[derive(Debug, Clone, PartialEq)]
pub enum CellValue {
    Text(String),
    Number(f64),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Cell {
    pub value: CellValue,
    pub bold: bool,
    /// Background colour as `#RRGGBB`.
    pub background: Option<&'static str>,
    pub number_format: Option<&'static str>,
}

impl Cell {
    fn text(value: impl Into<String>) -> Cell {
        Cell {
            value: CellValue::Text(value.into()),
            bold: false,
            background: None,
            number_format: None,
        }
    }

    fn bold(mut self) -> Cell {
        self.bold = true;
        self
    }

    /// Euros as a number with two decimals, or an empty cell without an amount.
    fn money(cents: Option<i64>) -> Cell {
        match cents {
            Some(cents) => Cell {
                value: CellValue::Number(cents as f64 / 100.0),
                bold: false,
                background: None,
                number_format: Some(MONEY_FORMAT),
            },
            None => Cell::text(""),
        }
    }

    /// Length of the value as text, for sizing its column.
    fn width(&self) -> usize {
        match &self.value {
            CellValue::Text(text) => js_len(text),
            CellValue::Number(number) => number.to_string().len(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Sheet {
    pub name: String,
    /// Column widths in characters.
    pub widths: Vec<usize>,
    pub rows: Vec<Vec<Cell>>,
}

impl Sheet {
    fn new(name: &str, headers: &[&str], data: Vec<Vec<Cell>>) -> Sheet {
        let mut rows = vec![headers
            .iter()
            .map(|h| Cell::text(*h).bold())
            .collect::<Vec<_>>()];
        rows.extend(data);
        let widths = (0..headers.len())
            .map(|col| {
                let longest = rows
                    .iter()
                    .filter_map(|r| r.get(col))
                    .map(Cell::width)
                    .max()
                    .unwrap_or(0);
                (longest + 2).clamp(MIN_WIDTH, MAX_WIDTH)
            })
            .collect();
        Sheet {
            name: name.to_string(),
            widths,
            rows,
        }
    }
}

fn status_label(status: Status) -> &'static str {
    match status {
        Status::Matched => "MATCHED",
        Status::Review => "REVIEW",
        Status::Unmatched => "UNMATCHED",
    }
}

fn status_background(status: Status) -> &'static str {
    match status {
        Status::Matched => "#C6EFCE",
        Status::Review => "#FFEB9C",
        Status::Unmatched => "#FFC7CE",
    }
}

fn confidence(value: Option<&str>, s: &Strings) -> String {
    match value {
        None | Some("") => String::new(),
        Some("high") => s.confidence_high.to_string(),
        Some(other) => other.to_string(),
    }
}

fn plural((one, many): (&str, &str), n: usize) -> String {
    if n == 1 {
        one.to_string()
    } else {
        many.replace("{n}", &n.to_string())
    }
}

static COUNTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^([0-9]+) (receipts match name\+amount \(unknown currency\)|receipts match name\+amount|receipts match amount \(unknown currency\)|receipts match amount|fx receipts within (.+)|receipts match by filename)$",
    )
    .expect("pattern compiles")
});

/// The text from the first `(` to the last `)` in a note, empty when there is none.
fn detail(notes: &str) -> &str {
    match (notes.find('('), notes.rfind(')')) {
        (Some(open), Some(close)) if open < close => &notes[open + 1..close],
        _ => "",
    }
}

/// The report's language and the names of the no-receipt reasons.
pub struct Labels<'a> {
    pub language: Language,
    pub reasons: &'a [Reason],
}

/// The matcher's note code as a label in the report's language. A reason id reads as the
/// reason's name. Unknown codes are kept.
fn format_notes(notes: &str, s: &Strings, labels: &Labels) -> String {
    if is_reason_id(notes) {
        return reason_label(labels.reasons, notes, labels.language);
    }
    match notes {
        "" => return String::new(),
        "name_amount_match" => return s.name_amount_match.to_string(),
        "name_amount_date_match" => return s.name_amount_date_match.to_string(),
        "amount_match" => return s.amount_match.to_string(),
        "amount_date_match" => return s.amount_date_match.to_string(),
        "unknown_currency_match" => return s.unknown_currency_match.to_string(),
        "manual_match" => return s.manual_match.to_string(),
        _ => {}
    }
    if notes.starts_with("fx_match") {
        return format!("{}{}{}", s.fx_match.0, detail(notes), s.fx_match.1);
    }
    if notes.starts_with("filename_match") {
        return s.filename_match.to_string();
    }
    if notes.starts_with("rule_match_amount") {
        let (before, after) = s.rule_match_amount;
        return format!("{before}{}{after}", detail(notes));
    }
    if notes.starts_with("rule_match") {
        return format!("{}{}{}", s.rule_match.0, detail(notes), s.rule_match.1);
    }
    let Some(c) = COUNTED.captures(notes) else {
        return notes.to_string();
    };
    let n: usize = c[1].parse().unwrap_or(0);
    let kind = &c[2];
    if let Some(tolerance) = c.get(3) {
        return plural(s.multiple_fx, n).replace("{tol}", tolerance.as_str());
    }
    let template = match kind {
        "receipts match name+amount (unknown currency)" => s.multiple_name_amount_unknown_currency,
        "receipts match name+amount" => s.multiple_name_amount,
        "receipts match amount (unknown currency)" => s.multiple_amount_unknown_currency,
        "receipts match amount" => s.multiple_amount,
        _ => s.multiple_filename,
    };
    plural(template, n)
}

fn validated_sheet(transactions: &[Transaction], s: &Strings, labels: &Labels) -> Sheet {
    let rows = transactions
        .iter()
        .map(|tx| {
            let join = |f: &dyn Fn(&ReceiptMeta) -> String| {
                tx.receipt_meta.iter().map(f).collect::<Vec<_>>().join("; ")
            };
            let mut status = Cell::text(status_label(tx.status));
            status.background = Some(status_background(tx.status));
            vec![
                Cell::text(&tx.date),
                Cell::text(&tx.description),
                Cell::money(Some(tx.amount_cents)),
                status,
                Cell::text(
                    tx.receipt_files
                        .iter()
                        .map(|f| basename(f))
                        .collect::<Vec<_>>()
                        .join("; "),
                ),
                Cell::text(join(&|m| {
                    m.amount_cents
                        .map(|c| format!("{:.2}", c as f64 / 100.0))
                        .unwrap_or_default()
                })),
                Cell::text(join(&|m| confidence(m.confidence.as_deref(), s))),
                Cell::text(join(&|m| m.currency.clone().unwrap_or_default())),
                Cell::text(format_notes(&tx.notes, s, labels)),
            ]
        })
        .collect();
    Sheet::new(
        s.sheet_validated,
        &[
            s.tx_date,
            s.tx_description,
            s.tx_amount,
            s.tx_status,
            s.tx_receipt_file,
            s.tx_receipt_amount,
            s.tx_receipt_confidence,
            s.tx_receipt_currency,
            s.tx_notes,
        ],
        rows,
    )
}

fn sum_cents(receipts: &[ReceiptMeta]) -> i64 {
    receipts.iter().filter_map(|r| r.amount_cents).sum()
}

fn totals_sheet(
    transactions: &[Transaction],
    unmatched: &[ReceiptMeta],
    reimbursements: &[ReceiptMeta],
    s: &Strings,
    reasons: &[Reason],
) -> Sheet {
    let without_receipt: i64 = transactions
        .iter()
        .filter(|t| t.status == Status::Matched && is_other_reason(reasons, &t.notes))
        .map(|t| t.amount_cents)
        .sum();
    let mut rows = vec![
        vec![
            Cell::text(s.totals_tx_without_receipt),
            Cell::money(Some(without_receipt)),
        ],
        vec![
            Cell::text(s.totals_unmatched_receipts),
            Cell::money(Some(sum_cents(unmatched))),
        ],
    ];
    if !reimbursements.is_empty() {
        rows.push(vec![
            Cell::text(s.totals_reimbursements),
            Cell::money(Some(sum_cents(reimbursements))),
        ]);
    }
    Sheet::new(s.sheet_totals, &[s.totals_label, s.totals_amount], rows)
}

fn receipt_cells(m: &ReceiptMeta, s: &Strings) -> Vec<Cell> {
    vec![
        Cell::text(basename(&m.file)),
        Cell::text(m.vendor.clone().unwrap_or_default()),
        Cell::text(m.date.clone().unwrap_or_default()),
        Cell::money(m.amount_cents),
        Cell::text(m.currency.clone().unwrap_or_default()),
        Cell::text(confidence(m.confidence.as_deref(), s)),
    ]
}

fn receipt_headers(s: &Strings) -> [&'static str; 6] {
    [
        s.receipt_file,
        s.receipt_vendor,
        s.receipt_date,
        s.receipt_amount,
        s.receipt_currency,
        s.receipt_confidence,
    ]
}

fn transaction_receipts_sheet(
    name: &str,
    transactions: &[Transaction],
    status: Status,
    s: &Strings,
) -> Sheet {
    let rows = transactions
        .iter()
        .filter(|tx| tx.status == status)
        .filter(|tx| !(status == Status::Matched && is_reason_id(&tx.notes)))
        .flat_map(|tx| {
            tx.receipt_meta.iter().map(move |m| {
                let mut row = receipt_cells(m, s);
                row.extend([
                    Cell::text(&tx.date),
                    Cell::text(&tx.description),
                    Cell::money(Some(tx.amount_cents)),
                ]);
                row
            })
        })
        .collect();
    let mut headers = receipt_headers(s).to_vec();
    headers.extend([
        s.receipt_tx_date,
        s.receipt_tx_description,
        s.receipt_tx_amount,
    ]);
    Sheet::new(name, &headers, rows)
}

fn unmatched_sheet(unmatched: &[ReceiptMeta], s: &Strings) -> Sheet {
    let rows = unmatched.iter().map(|m| receipt_cells(m, s)).collect();
    Sheet::new(s.sheet_unmatched, &receipt_headers(s), rows)
}

fn reimbursements_sheet(reimbursements: &[ReceiptMeta], s: &Strings) -> Sheet {
    let mut rows: Vec<Vec<Cell>> = reimbursements.iter().map(|m| receipt_cells(m, s)).collect();
    if !rows.is_empty() {
        rows.push(vec![
            Cell::text(s.reimbursements_total).bold(),
            Cell::text(""),
            Cell::text(""),
            Cell::money(Some(sum_cents(reimbursements))).bold(),
            Cell::text(""),
            Cell::text(""),
        ]);
    }
    Sheet::new(s.sheet_reimbursements, &receipt_headers(s), rows)
}

/// Lays out the report's sheets.
pub fn build(result: &MatchResult, reimbursements: &[ReceiptMeta], labels: &Labels) -> Vec<Sheet> {
    let s = strings(labels.language);
    let txs = &result.transactions;
    let mut sheets = vec![
        totals_sheet(
            txs,
            &result.unmatched_receipts,
            reimbursements,
            s,
            labels.reasons,
        ),
        validated_sheet(txs, s, labels),
        transaction_receipts_sheet(s.sheet_matched, txs, Status::Matched, s),
        transaction_receipts_sheet(s.sheet_review, txs, Status::Review, s),
        unmatched_sheet(&result.unmatched_receipts, s),
    ];
    if !reimbursements.is_empty() {
        sheets.push(reimbursements_sheet(reimbursements, s));
    }
    sheets
}

fn color(hex: &str) -> Color {
    Color::RGB(u32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap_or(0xFFFFFF))
}

/// What a cell's format depends on.
type FormatKey = (bool, Option<&'static str>, Option<&'static str>);

fn format_for(key: FormatKey) -> Format {
    let (bold, background, number_format) = key;
    let mut format = Format::new();
    if bold {
        format = format.set_bold();
    }
    if let Some(background) = background {
        format = format.set_background_color(color(background));
    }
    if let Some(number_format) = number_format {
        format = format.set_num_format(number_format);
    }
    format
}

/// Saves the sheets as an `.xlsx` file. Empty text cells are left blank. Cells with the same
/// styling share one format.
pub fn write(sheets: &[Sheet], path: &Path) -> Result<(), XlsxError> {
    let mut workbook = Workbook::new();
    let mut formats: HashMap<FormatKey, Format> = HashMap::new();
    for sheet in sheets {
        let worksheet = workbook.add_worksheet();
        worksheet.set_name(&sheet.name)?;
        for (col, width) in sheet.widths.iter().enumerate() {
            worksheet.set_column_width(col as u16, *width as f64)?;
        }
        for (row, cells) in sheet.rows.iter().enumerate() {
            for (col, cell) in cells.iter().enumerate() {
                let (row, col) = (row as u32, col as u16);
                let value = match &cell.value {
                    CellValue::Text(text) if text.is_empty() => continue,
                    value => value,
                };
                let key = (cell.bold, cell.background, cell.number_format);
                let format = formats.entry(key).or_insert_with(|| format_for(key));
                match value {
                    CellValue::Text(text) => {
                        worksheet.write_string_with_format(row, col, text, format)?;
                    }
                    CellValue::Number(number) => {
                        worksheet.write_number_with_format(row, col, *number, format)?;
                    }
                }
            }
        }
    }
    workbook.save(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_nested_parentheses_in_a_detail() {
        let reasons = crate::model::default_reasons();
        let labels = Labels {
            language: Language::En,
            reasons: &reasons,
        };
        let en = strings(Language::En);
        assert_eq!(
            format_notes("rule_match (ACME (EU))", en, &labels),
            "Rule match (ACME (EU))"
        );
        assert_eq!(detail("rule_match ()"), "");
        assert_eq!(detail("rule_match"), "");
    }

    #[test]
    fn labels_note_codes() {
        let reasons = crate::model::default_reasons();
        let en_labels = Labels {
            language: Language::En,
            reasons: &reasons,
        };
        let pt_labels = Labels {
            language: Language::Pt,
            reasons: &reasons,
        };
        let en = strings(Language::En);
        let pt = strings(Language::Pt);
        assert_eq!(
            format_notes("fx_match (USD ±10%)", en, &en_labels),
            "Foreign-currency match (USD ±10%)"
        );
        assert_eq!(
            format_notes("rule_match (ACME)", en, &en_labels),
            "Rule match (ACME)"
        );
        assert_eq!(
            format_notes("rule_match_amount (ACME)", en, &en_labels),
            "Rule match, different amount (ACME)"
        );
        assert_eq!(
            format_notes("rule_match_amount (ACME)", pt, &pt_labels),
            "Regra de associação, valor diferente (ACME)"
        );
        assert_eq!(
            format_notes("filename_match (acme.pdf)", en, &en_labels),
            "Filename match — verify amounts"
        );
        assert_eq!(
            format_notes("1 receipts match amount", en, &en_labels),
            "1 receipt matches amount"
        );
        assert_eq!(
            format_notes("3 fx receipts within ±10%", en, &en_labels),
            "3 foreign-currency receipts within ±10%"
        );
        assert_eq!(
            format_notes("1 fx receipts within ±10%", en, &en_labels),
            "1 foreign-currency receipt within ±10%"
        );
        assert_eq!(
            format_notes(
                "2 receipts match name+amount (unknown currency)",
                en,
                &en_labels
            ),
            "2 receipts match name & amount (currency unverified)"
        );
        assert_eq!(
            format_notes("something new", en, &en_labels),
            "something new"
        );
        assert_eq!(
            format_notes("bank_fee", pt, &pt_labels),
            "Comissão bancária"
        );
        assert_eq!(format_notes("salary", en, &en_labels), "Salary");
        assert_eq!(format_notes("reason:gone", pt, &pt_labels), "Outro");
    }

    #[test]
    fn sizes_columns_between_ten_and_fifty() {
        let sheet = Sheet::new(
            "S",
            &["A", "B"],
            vec![vec![Cell::text("x".repeat(80)), Cell::money(Some(123_456))]],
        );
        assert_eq!(sheet.widths, [50, 10]);
    }
}
