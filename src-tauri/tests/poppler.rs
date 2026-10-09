//! The poppler tools on real PDFs. Skipped when poppler is not installed.

mod common;

use std::path::PathBuf;

use concilia_lib::bank::Bank;
use concilia_lib::poppler::{Poppler, PopplerError};

macro_rules! require_poppler {
    () => {
        match common::poppler_on_path() {
            Some(poppler) => poppler,
            None => {
                eprintln!("poppler not installed; skipping");
                return;
            }
        }
    };
}

#[tokio::test]
async fn extracts_text_from_a_pdf() {
    let poppler = require_poppler!();
    let pdf = common::pdf_with_lines(&["ACME CORP", "TOTAL 10,00 EUR"]);
    let text = poppler.text(&pdf).await.unwrap();
    assert!(text.contains("ACME CORP"), "{text}");
    assert!(text.contains("TOTAL 10,00 EUR"), "{text}");
}

#[tokio::test]
async fn parses_a_statement_end_to_end() {
    let poppler = require_poppler!();
    let pdf = common::pdf_with_lines(&[
        "EXTRATO EXAMPLE BANK",
        "  2030-03-01 2030-03-01 ACME CORP              -10,00      90,00",
        "  2030-03-02 2030-02-28 EXAMPLE FEE             -1,00      89,00",
        "SALDO FINAL 89,00",
    ]);
    let text = poppler.text(&pdf).await.unwrap();
    let rows = Bank::Cgd.parse_text(&text);
    let summary: Vec<(String, String, i64)> = rows
        .into_iter()
        .map(|r| (r.date, r.description, r.amount_cents))
        .collect();
    assert_eq!(
        summary,
        [
            ("01/03/2030".to_string(), "ACME CORP".to_string(), -1000),
            ("02/03/2030".to_string(), "EXAMPLE FEE".to_string(), -100),
        ]
    );
}

#[tokio::test]
async fn renders_a_page_to_png() {
    let poppler = require_poppler!();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("acme.pdf");
    std::fs::write(&path, common::pdf_with_lines(&["ACME CORP"])).unwrap();
    let png = poppler.render_page(&path, 1, 72).await.unwrap();
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
}

#[tokio::test]
async fn reports_invalid_pdfs() {
    let poppler = require_poppler!();
    let error = poppler.text(b"not a pdf").await.unwrap_err();
    assert!(matches!(error, PopplerError::Failed(_)), "{error:?}");
}

#[tokio::test]
async fn reports_missing_tools() {
    let poppler = Poppler {
        pdftotext: PathBuf::from("/nonexistent/pdftotext"),
        pdftoppm: PathBuf::from("/nonexistent/pdftoppm"),
        bundled: false,
    };
    assert!(matches!(
        poppler.text(b"%PDF").await,
        Err(PopplerError::Missing(_))
    ));
    let missing = poppler.render_page(&PathBuf::from("/x.pdf"), 1, 72).await;
    assert!(matches!(missing, Err(PopplerError::Missing(_))));
}
