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

/// Writes `bytes` to a file in `dir` and returns its path.
fn file_in(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.path().join(name);
    std::fs::write(&path, bytes).unwrap();
    path
}

#[tokio::test]
async fn extracts_text_from_a_pdf() {
    let poppler = require_poppler!();
    let dir = tempfile::tempdir().unwrap();
    let pdf = file_in(
        &dir,
        "acme.pdf",
        &common::pdf_with_lines(&["ACME CORP", "TOTAL 10,00 EUR"]),
    );
    let text = poppler.text(&pdf).await.unwrap();
    assert!(text.contains("ACME CORP"), "{text}");
    assert!(text.contains("TOTAL 10,00 EUR"), "{text}");
}

#[tokio::test]
async fn parses_a_statement_end_to_end() {
    let poppler = require_poppler!();
    let dir = tempfile::tempdir().unwrap();
    let pdf = file_in(
        &dir,
        "statement.pdf",
        &common::pdf_with_lines(&[
            "EXTRATO EXAMPLE BANK",
            "  2030-03-01 2030-03-01 ACME CORP              -10,00      90,00",
            "  2030-03-02 2030-02-28 EXAMPLE FEE             -1,00      89,00",
            "SALDO FINAL 89,00",
        ]),
    );
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

/// Width and height of a PNG, from its header.
fn png_size(png: &[u8]) -> (u32, u32) {
    let number = |at: usize| u32::from_be_bytes(png[at..at + 4].try_into().unwrap());
    (number(16), number(20))
}

#[tokio::test]
async fn renders_large_pages_within_the_pixel_cap_and_small_ones_at_full_resolution() {
    let poppler = require_poppler!();
    let dir = tempfile::tempdir().unwrap();
    let a4 = file_in(&dir, "a4.pdf", &common::pdf_with_lines(&["ACME CORP"]));
    let (width, height) = png_size(&poppler.render_page(&a4, 1, 300).await.unwrap());
    assert!((3500..=3509).contains(&height), "{width}x{height}");

    let poster = common::pdf_with_lines(&["ACME CORP"]);
    let poster = String::from_utf8_lossy(&poster).replace("[0 0 595 842]", "[0 0 2000 3000]");
    let poster = file_in(&dir, "poster.pdf", poster.as_bytes());
    let (width, height) = png_size(&poppler.render_page(&poster, 1, 300).await.unwrap());
    assert!(height <= 3509 && width < height, "{width}x{height}");

    let small = common::pdf_with_lines(&["ACME CORP"]);
    let small = String::from_utf8_lossy(&small).replace("[0 0 595 842]", "[0 0 216 576]");
    let small = file_in(&dir, "small.pdf", small.as_bytes());
    let (width, height) = png_size(&poppler.render_page(&small, 1, 300).await.unwrap());
    // Older poppler rounds a size that is exact in theory up by one pixel.
    assert!((900..=901).contains(&width), "{width}x{height}");
    assert!((2400..=2401).contains(&height), "{width}x{height}");
}

#[tokio::test]
async fn reports_invalid_pdfs() {
    let poppler = require_poppler!();
    let dir = tempfile::tempdir().unwrap();
    let pdf = file_in(&dir, "fake.pdf", b"not a pdf");
    let error = poppler.text(&pdf).await.unwrap_err();
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
        poppler.text(&PathBuf::from("/x.pdf")).await,
        Err(PopplerError::Missing(_))
    ));
    let missing = poppler.render_page(&PathBuf::from("/x.pdf"), 1, 72).await;
    assert!(matches!(missing, Err(PopplerError::Missing(_))));
}
