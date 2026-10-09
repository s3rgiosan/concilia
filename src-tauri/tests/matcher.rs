//! Matching behaviour of `match_transactions`, pass by pass.

use concilia_lib::matcher::match_transactions;
use concilia_lib::model::{MatchResult, ReceiptMeta, Rule, StatementTransaction, Status};
use regex::Regex;
use serde_json::Map;

fn tx(id: &str, date: &str, description: &str, amount_cents: i64) -> StatementTransaction {
    StatementTransaction {
        id: id.to_string(),
        date: date.to_string(),
        description: description.to_string(),
        amount_cents,
        abs_cents: amount_cents.abs(),
        status: Status::Unmatched,
        extra: Map::new(),
    }
}

/// A high-confidence Gemini receipt with no vendor.
fn receipt(
    file: &str,
    amount_cents: Option<i64>,
    date: Option<&str>,
    currency: Option<&str>,
) -> ReceiptMeta {
    ReceiptMeta {
        file: file.to_string(),
        amount_cents,
        confidence: Some("high".to_string()),
        currency: currency.map(str::to_string),
        vendor: None,
        date: date.map(str::to_string),
        provider_used: Some("gemini".to_string()),
        extra: Map::new(),
    }
}

/// A high-confidence EUR receipt with no date and no vendor.
fn eur(file: &str, amount_cents: i64) -> ReceiptMeta {
    receipt(file, Some(amount_cents), None, Some("EUR"))
}

/// A receipt whose extraction failed: no amount, confidence or currency.
fn broken(file: &str) -> ReceiptMeta {
    ReceiptMeta {
        confidence: None,
        ..receipt(file, None, None, None)
    }
}

fn with_vendor(receipt: ReceiptMeta, vendor: &str) -> ReceiptMeta {
    ReceiptMeta {
        vendor: Some(vendor.to_string()),
        ..receipt
    }
}

fn rule(id: &str, receipt_vendor: &str, transaction_description: &str) -> Rule {
    Rule {
        id: id.to_string(),
        receipt_vendor: receipt_vendor.to_string(),
        transaction_description: transaction_description.to_string(),
    }
}

fn run(transactions: &[StatementTransaction], receipts: &[ReceiptMeta]) -> MatchResult {
    match_transactions(transactions, receipts, &[])
}

fn assert_notes_match(notes: &str, pattern: &str) {
    let re = Regex::new(pattern).unwrap();
    assert!(
        re.is_match(notes),
        "notes {notes:?} do not match /{pattern}/"
    );
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

// matchTransactions > amount match (single candidate)

#[test]
fn matches_transaction_to_receipt_with_same_abs_amount() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMPRA LOJA", -5000)],
        &[eur("/r/a.pdf", 5000)],
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Matched);
    assert_eq!(t.receipt_files, strings(&["/r/a.pdf"]));
    assert_eq!(t.notes, "amount_match");
}

#[test]
fn rejects_any_cent_difference_for_eur_receipts() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMPRA", -5000)],
        &[eur("/r/a.pdf", 5001)],
    );
    assert_eq!(result.transactions[0].status, Status::Unmatched);
}

// matchTransactions > ambiguous match (multiple candidates)

#[test]
fn marks_as_review_when_multiple_receipts_match() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMPRA", -5000)],
        &[eur("/r/a.pdf", 5000), eur("/r/b.pdf", 5000)],
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Review);
    assert_eq!(t.receipt_files.len(), 2);
    assert_notes_match(&t.notes, "2 receipts");
}

#[test]
fn does_not_consume_receipts_for_review_items() {
    let result = run(
        &[
            tx("tx-001", "2024-12-15", "COMPRA A", -5000),
            tx("tx-002", "2024-12-16", "COMPRA B", -5000),
        ],
        &[eur("/r/a.pdf", 5000), eur("/r/b.pdf", 5000)],
    );
    assert_eq!(result.transactions[0].status, Status::Review);
    assert_eq!(result.transactions[1].status, Status::Review);
}

// matchTransactions > no match

#[test]
fn marks_as_unmatched_when_no_receipt_fits() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMPRA", -5000)],
        &[eur("/r/a.pdf", 9900)],
    );
    assert_eq!(result.transactions[0].status, Status::Unmatched);
}

#[test]
fn marks_as_unmatched_when_no_receipts_at_all() {
    let result = run(&[tx("tx-001", "2024-12-15", "COMPRA", -5000)], &[]);
    assert_eq!(result.transactions[0].status, Status::Unmatched);
}

// matchTransactions > bank fee detection

#[test]
fn auto_matches_comissao_as_bank_fee() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMISSÃO DE DÉBITO", -250)],
        &[],
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Matched);
    assert_eq!(t.notes, "bank_fee");
}

#[test]
fn auto_matches_monthly_fee_as_bank_fee() {
    let result = run(&[tx("tx-001", "2024-12-15", "MONTHLY FEE", -500)], &[]);
    assert_eq!(result.transactions[0].status, Status::Matched);
    assert_eq!(result.transactions[0].notes, "bank_fee");
}

#[test]
fn bank_fee_takes_priority_over_amount_match() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "JUROS CREDORES", -500)],
        &[eur("/r/a.pdf", 500)],
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Matched);
    assert_eq!(t.notes, "bank_fee");
    assert_eq!(result.receipts_by_status.matched.len(), 0);
}

// matchTransactions > receipt consumption

#[test]
fn consumed_receipt_is_not_reused() {
    let result = run(
        &[
            tx("tx-001", "2024-12-15", "COMPRA A", -5000),
            tx("tx-002", "2024-12-16", "COMPRA B", -5000),
        ],
        &[eur("/r/a.pdf", 5000)],
    );
    assert_eq!(result.transactions[0].status, Status::Matched);
    assert_eq!(result.transactions[1].status, Status::Unmatched);
}

// matchTransactions > receipt sorting

#[test]
fn separates_receipts_into_matched_review_unmatched() {
    let result = run(
        &[
            tx("tx-001", "2024-12-15", "COMPRA A", -5000),
            tx("tx-002", "2024-12-16", "COMPRA B", -3000),
        ],
        &[eur("/r/matched.pdf", 5000), eur("/r/unmatched.pdf", 9900)],
    );
    assert_eq!(
        result.receipts_by_status.matched,
        strings(&["/r/matched.pdf"])
    );
    assert!(result.receipts_by_status.review.is_empty());
    assert_eq!(
        result.receipts_by_status.unmatched,
        strings(&["/r/unmatched.pdf"])
    );
}

#[test]
fn puts_review_receipts_in_review_bucket() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMPRA", -5000)],
        &[eur("/r/a.pdf", 5000), eur("/r/b.pdf", 5000)],
    );
    assert_eq!(result.receipts_by_status.review.len(), 2);
    assert_eq!(result.receipts_by_status.matched.len(), 0);
}

// matchTransactions > null amount receipts

#[test]
fn treats_receipts_with_null_amount_as_unmatched() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMPRA", -5000)],
        &[broken("/r/broken.pdf")],
    );
    assert_eq!(result.transactions[0].status, Status::Unmatched);
    assert_eq!(
        result.receipts_by_status.unmatched,
        strings(&["/r/broken.pdf"])
    );
}

#[test]
fn matches_valid_receipt_when_null_amount_receipt_appears_first() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMPRA", -5000)],
        &[broken("/r/broken.pdf"), eur("/r/valid.pdf", 5000)],
    );
    assert_eq!(result.transactions[0].status, Status::Matched);
    assert_eq!(
        result.transactions[0].receipt_files,
        strings(&["/r/valid.pdf"])
    );
    assert_eq!(
        result.receipts_by_status.unmatched,
        strings(&["/r/broken.pdf"])
    );
}

// matchTransactions > receipt_meta in output

#[test]
fn includes_receipt_meta_for_matched_transactions() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMPRA LOJA", -5000)],
        &[eur("/r/a.pdf", 5000)],
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Matched);
    assert_eq!(t.receipt_meta.len(), 1);
    assert_eq!(t.receipt_meta[0].file, "/r/a.pdf");
    assert_eq!(t.receipt_meta[0].amount_cents, Some(5000));
}

#[test]
fn includes_receipt_meta_for_review_transactions() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMPRA", -5000)],
        &[eur("/r/a.pdf", 5000), eur("/r/b.pdf", 5000)],
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Review);
    assert_eq!(t.receipt_meta.len(), 2);
}

#[test]
fn has_empty_receipt_meta_for_bank_fees() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMISSÃO DE DÉBITO", -250)],
        &[],
    );
    assert!(result.transactions[0].receipt_meta.is_empty());
}

#[test]
fn has_empty_receipt_meta_for_unmatched_transactions() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMPRA", -5000)],
        &[eur("/r/a.pdf", 9900)],
    );
    assert!(result.transactions[0].receipt_meta.is_empty());
}

#[test]
fn preserves_extra_receipt_properties_in_receipt_meta() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMPRA", -5000)],
        &[eur("/r/a.pdf", 5000)],
    );
    assert_eq!(
        result.transactions[0].receipt_meta[0].currency.as_deref(),
        Some("EUR")
    );
}

#[test]
fn usd_receipt_with_exact_amount_goes_to_fx_review_not_amount_match() {
    // The name must overlap for the FX pass to include the receipt.
    let r = receipt("/r/Zenith invoice.pdf", Some(5000), None, Some("USD"));
    let result = run(&[tx("tx-001", "2024-12-15", "ZENITH", -5000)], &[r]);
    assert_eq!(result.transactions[0].status, Status::Review);
    assert_notes_match(&result.transactions[0].notes, "fx_match");
}

#[test]
fn eur_receipt_matches_by_amount_in_pass_2() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMPRA", -5000)],
        &[eur("/r/a.pdf", 5000)],
    );
    assert_eq!(result.transactions[0].status, Status::Matched);
    assert_eq!(result.transactions[0].notes, "amount_match");
}

// matchTransactions > unmatchedReceipts in output

#[test]
fn returns_unmatched_receipts_as_full_objects() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMPRA", -5000)],
        &[eur("/r/unmatched.pdf", 9900)],
    );
    assert_eq!(result.unmatched_receipts.len(), 1);
    assert_eq!(result.unmatched_receipts[0].file, "/r/unmatched.pdf");
    assert_eq!(result.unmatched_receipts[0].amount_cents, Some(9900));
}

#[test]
fn returns_empty_array_when_all_receipts_matched() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMPRA", -5000)],
        &[eur("/r/a.pdf", 5000)],
    );
    assert_eq!(result.unmatched_receipts.len(), 0);
}

#[test]
fn excludes_review_receipts_from_unmatched_receipts() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMPRA", -5000)],
        &[eur("/r/a.pdf", 5000), eur("/r/b.pdf", 5000)],
    );
    assert_eq!(result.unmatched_receipts.len(), 0);
}

#[test]
fn includes_null_amount_receipts_in_unmatched_receipts() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMPRA", -5000)],
        &[broken("/r/broken.pdf")],
    );
    assert_eq!(result.unmatched_receipts.len(), 1);
    assert_eq!(result.unmatched_receipts[0].file, "/r/broken.pdf");
}

// matchTransactions > name disambiguation

#[test]
fn disambiguates_multiple_amount_candidates_by_filename() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "MELODY PREMIUM", -1700)],
        &[
            eur("/r/Melody Premium.pdf", 1700),
            eur("/r/random-receipt.pdf", 1700),
        ],
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Matched);
    assert_eq!(t.receipt_files, strings(&["/r/Melody Premium.pdf"]));
    assert_eq!(t.notes, "name_amount_match");
}

#[test]
fn falls_back_to_review_when_no_name_disambiguates() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "MELODY PREMIUM", -1700)],
        &[eur("/r/a.pdf", 1700), eur("/r/b.pdf", 1700)],
    );
    assert_eq!(result.transactions[0].status, Status::Review);
}

#[test]
fn eur_receipt_matched_in_pass_2_non_eur_left_for_fx() {
    let eur_receipt = eur("/r/eur.pdf", 1700);
    let usd_receipt = receipt("/r/CloudCo.pdf", Some(1700), None, Some("USD"));
    let result = run(
        &[
            tx("tx-001", "2024-12-15", "SOME PURCHASE", -1700),
            tx("tx-002", "2024-12-16", "CLOUDCO", -1600),
        ],
        &[usd_receipt, eur_receipt],
    );
    assert_eq!(result.transactions[0].status, Status::Matched);
    assert_eq!(
        result.transactions[0].receipt_files,
        strings(&["/r/eur.pdf"])
    );
    assert_eq!(result.transactions[1].status, Status::Review);
    assert_notes_match(&result.transactions[1].notes, "fx_match.*USD");
}

#[test]
fn disambiguates_fx_candidates_by_filename() {
    let r1 = receipt("/r/CloudCo Invoice.pdf", Some(4707), None, Some("USD"));
    let r2 = receipt("/r/some-other.pdf", Some(4500), None, Some("USD"));
    let result = run(&[tx("tx-001", "2024-12-15", "CLOUDCO", -4312)], &[r1, r2]);
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Review);
    assert_eq!(t.receipt_files.len(), 1);
    assert_eq!(t.receipt_files, strings(&["/r/CloudCo Invoice.pdf"]));
    assert_notes_match(&t.notes, "fx_match.*USD");
}

// matchTransactions > FX matching (pass 2)

#[test]
fn matches_usd_receipt_to_eur_transaction_within_10_percent_as_review_when_name_overlaps() {
    let r = with_vendor(
        receipt("/r/invoice.pdf", Some(4707), None, Some("USD")),
        "CloudCo",
    );
    let result = run(&[tx("tx-001", "2024-12-15", "CLOUDCO", -4312)], &[r]);
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Review);
    assert_eq!(t.receipt_files, strings(&["/r/invoice.pdf"]));
    assert_notes_match(&t.notes, "fx_match.*USD");
}

#[test]
fn does_not_fx_match_when_no_name_overlap_receipt_stays_unmatched() {
    let r = with_vendor(
        receipt("/r/hostprovider-invoice.pdf", Some(1700), None, Some("USD")),
        "HostProvider",
    );
    let result = run(&[tx("tx-001", "2024-12-15", "JANE DOE", -1650)], &[r]);
    assert_eq!(result.transactions[0].status, Status::Unmatched);
    assert_eq!(result.receipts_by_status.unmatched.len(), 1);
}

#[test]
fn does_not_fx_match_eur_receipts() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMPRA", -5000)],
        &[eur("/r/a.pdf", 5400)],
    );
    assert_eq!(result.transactions[0].status, Status::Unmatched);
}

#[test]
fn does_not_fx_match_receipts_without_currency() {
    let r = receipt("/r/a.pdf", Some(5400), None, None);
    let result = run(&[tx("tx-001", "2024-12-15", "COMPRA", -5000)], &[r]);
    assert_eq!(result.transactions[0].status, Status::Unmatched);
}

#[test]
fn does_not_fx_match_when_difference_exceeds_10_percent() {
    let r = receipt("/r/a.pdf", Some(5750), None, Some("USD"));
    let result = run(&[tx("tx-001", "2024-12-15", "COMPRA", -5000)], &[r]);
    assert_eq!(result.transactions[0].status, Status::Unmatched);
}

#[test]
fn prefers_exact_match_over_fx_match() {
    let eur_receipt = eur("/r/eur.pdf", 5000);
    let usd_receipt = receipt("/r/usd.pdf", Some(5200), None, Some("USD"));
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMPRA", -5000)],
        &[eur_receipt, usd_receipt],
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Matched);
    assert_eq!(t.notes, "amount_match");
    assert_eq!(t.receipt_files, strings(&["/r/eur.pdf"]));
}

#[test]
fn does_not_fx_match_already_consumed_receipts() {
    let result = run(
        &[
            tx("tx-001", "2024-12-15", "COMPRA A", -5000),
            tx("tx-002", "2024-12-16", "COMPRA B", -4800),
        ],
        &[eur("/r/eur.pdf", 5000)],
    );
    assert_eq!(result.transactions[0].status, Status::Matched);
    assert_eq!(result.transactions[1].status, Status::Unmatched);
}

#[test]
fn shows_multiple_fx_candidates_in_notes_when_both_have_name_overlap() {
    let r1 = with_vendor(receipt("/r/a.pdf", Some(5200), None, Some("USD")), "ShopCo");
    let r2 = with_vendor(receipt("/r/b.pdf", Some(5300), None, Some("GBP")), "ShopCo");
    let result = run(
        &[tx("tx-001", "2024-12-15", "SHOPCO PURCHASE", -5000)],
        &[r1, r2],
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Review);
    assert_eq!(t.receipt_files.len(), 2);
    assert_notes_match(&t.notes, "2 fx receipts");
}

#[test]
fn fx_matched_receipts_go_to_review_bucket() {
    let r = receipt("/r/CloudCo.pdf", Some(4707), None, Some("USD"));
    let result = run(&[tx("tx-001", "2024-12-15", "CLOUDCO", -4312)], &[r]);
    assert!(result
        .receipts_by_status
        .review
        .contains(&"/r/CloudCo.pdf".to_string()));
    assert_eq!(result.receipts_by_status.matched.len(), 0);
    assert_eq!(result.receipts_by_status.unmatched.len(), 0);
}

// matchTransactions > unknown currency matching

#[test]
fn does_not_auto_match_an_exact_cents_receipt_with_unknown_currency() {
    // The amount equals the transaction exactly, but the receipt could be in a foreign
    // currency, so it must not be MATCHED.
    let r = with_vendor(
        receipt("/r/ACME invoice.pdf", Some(4500), None, None),
        "Acme",
    );
    let result = run(&[tx("tx-001", "2024-12-15", "ACME CORP", -4500)], &[r]);
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Review);
    assert_eq!(t.notes, "unknown_currency_match");
    assert_eq!(t.receipt_files, strings(&["/r/ACME invoice.pdf"]));
}

#[test]
fn does_not_consume_an_unknown_currency_receipt_matched_to_review() {
    let r = with_vendor(
        receipt("/r/ACME invoice.pdf", Some(4500), None, None),
        "Acme",
    );
    let result = run(&[tx("tx-001", "2024-12-15", "ACME CORP", -4500)], &[r]);
    assert!(result
        .receipts_by_status
        .review
        .contains(&"/r/ACME invoice.pdf".to_string()));
    assert_eq!(result.receipts_by_status.matched.len(), 0);
}

#[test]
fn routes_unknown_currency_exact_amount_match_to_review_even_without_name_overlap() {
    let r = receipt("/r/unknown.pdf", Some(4500), None, None);
    let result = run(
        &[tx("tx-001", "2024-12-15", "SHOPCO PURCHASE", -4500)],
        &[r],
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Review);
    assert_eq!(t.notes, "unknown_currency_match");
}

#[test]
fn still_auto_matches_an_explicit_eur_receipt() {
    let r = with_vendor(eur("/r/ACME invoice.pdf", 4500), "Acme");
    let result = run(&[tx("tx-001", "2024-12-15", "ACME CORP", -4500)], &[r]);
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Matched);
    assert_eq!(t.notes, "name_amount_match");
}

#[test]
fn prefers_an_unambiguous_eur_match_over_an_unknown_currency_candidate_at_the_same_amount() {
    let eur_receipt = eur("/r/eur.pdf", 4500);
    let unknown_receipt = receipt("/r/unknown.pdf", Some(4500), None, None);
    let result = run(
        &[tx("tx-001", "2024-12-15", "COMPRA", -4500)],
        &[eur_receipt, unknown_receipt],
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Matched);
    assert_eq!(t.notes, "amount_match");
    assert_eq!(t.receipt_files, strings(&["/r/eur.pdf"]));
    assert!(!result
        .receipts_by_status
        .matched
        .contains(&"/r/unknown.pdf".to_string()));
}

// matchTransactions > filename matching (pass 3)

#[test]
fn matches_receipt_filename_to_transaction_description() {
    let r = receipt(
        "/r/CloudCo Invoice 2025 Oct.pdf",
        Some(4707),
        None,
        Some("USD"),
    );
    let result = run(&[tx("tx-001", "2024-12-15", "CLOUDCO", -4086)], &[r]);
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Review);
    assert_notes_match(&t.notes, "filename_match");
}

#[test]
fn does_not_filename_match_short_words() {
    // "ABC" is under four characters and "COMPRA" is a stop word.
    let result = run(
        &[tx("tx-001", "2024-12-15", "ABC COMPRA", -9999)],
        &[eur("/r/ABC report.pdf", 5000)],
    );
    assert_eq!(result.transactions[0].status, Status::Unmatched);
}

#[test]
fn prefers_name_amount_match_over_filename_only_match() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "CLOUDCO", -4086)],
        &[eur("/r/CloudCo.pdf", 4086)],
    );
    assert_eq!(result.transactions[0].status, Status::Matched);
    assert_eq!(result.transactions[0].notes, "name_amount_match");
}

#[test]
fn does_not_filename_match_consumed_receipts() {
    let result = run(
        &[
            tx("tx-001", "2024-12-15", "COMPRA QUALQUER", -4086),
            tx("tx-002", "2024-12-16", "CLOUDCO", -9999),
        ],
        &[eur("/r/CloudCo.pdf", 4086)],
    );
    assert_eq!(result.transactions[0].status, Status::Matched);
    assert_eq!(result.transactions[1].status, Status::Unmatched);
}

#[test]
fn filename_match_receipts_go_to_review_bucket() {
    let r = receipt("/r/CloudCo Invoice.pdf", Some(4707), None, Some("USD"));
    let result = run(&[tx("tx-001", "2024-12-15", "CLOUDCO", -4086)], &[r]);
    assert!(result
        .receipts_by_status
        .review
        .contains(&"/r/CloudCo Invoice.pdf".to_string()));
}

#[test]
fn filename_matches_receipt_outside_fx_tolerance() {
    let r = receipt(
        "/r/CloudCo Invoice 2025 Oct.pdf",
        Some(4707),
        None,
        Some("USD"),
    );
    let result = run(&[tx("tx-001", "2024-12-15", "CLOUDCO", -4086)], &[r]);
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Review);
    assert_notes_match(&t.notes, "filename_match");
}

#[test]
fn filename_matches_receipt_with_null_amount() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "CLOUDCO", -4086)],
        &[broken("/r/CloudCo Invoice.pdf")],
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Review);
    assert_notes_match(&t.notes, "filename_match");
}

#[test]
fn does_not_filename_match_eur_receipt_when_amount_differs_beyond_tolerance() {
    let result = run(
        &[tx("tx-001", "2024-12-15", "MELODY PREMIUM", -1200)],
        &[eur("/r/Melody Premium Jan.pdf", 999)],
    );
    assert_eq!(result.transactions[0].status, Status::Unmatched);
}

#[test]
fn filename_matches_eur_receipt_when_amount_equals_exactly() {
    // Pass 1 (name and amount) catches it before the filename pass.
    let result = run(
        &[tx("tx-001", "2024-12-15", "MELODY PREMIUM", -1000)],
        &[eur("/r/Melody Premium Jan.pdf", 1000)],
    );
    assert_eq!(result.transactions[0].status, Status::Matched);
    assert_eq!(result.transactions[0].notes, "name_amount_match");
}

// matchTransactions > custom rules (Pass 0)

#[test]
fn matches_via_rule_when_vendor_and_description_keywords_match() {
    let rules = [rule("1", "postbox", "paywave")];
    let result = match_transactions(
        &[tx("tx-001", "2024-12-15", "PAYWAVE.NET CHARGE", -1200)],
        &[with_vendor(eur("/r/postbox.pdf", 999), "Postbox Pty Ltd")],
        &rules,
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Matched);
    assert!(t.notes.starts_with("rule_match"));
}

#[test]
fn does_not_apply_rule_when_vendor_keyword_does_not_match() {
    let rules = [rule("1", "postbox", "paywave")];
    let result = match_transactions(
        &[tx("tx-001", "2024-12-15", "PAYWAVE.NET CHARGE", -1200)],
        &[with_vendor(eur("/r/other.pdf", 1200), "Other Corp")],
        &rules,
    );
    assert_eq!(result.transactions[0].status, Status::Matched);
    assert_eq!(result.transactions[0].notes, "amount_match");
}

#[test]
fn matches_via_rule_using_filename_when_vendor_is_null() {
    let rules = [rule("1", "postbox", "paywave")];
    let result = match_transactions(
        &[tx("tx-001", "2024-12-15", "PAYWAVE.NET CHARGE", -1200)],
        &[eur("/r/postbox_invoice.pdf", 999)],
        &rules,
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Matched);
    assert!(t.notes.starts_with("rule_match"));
}

#[test]
fn matches_via_rule_when_receipt_has_null_amount_cents() {
    let rules = [rule("1", "postbox", "paywave")];
    let r = ReceiptMeta {
        confidence: None,
        ..with_vendor(
            receipt("/r/postbox.pdf", None, None, Some("EUR")),
            "Postbox Pty Ltd",
        )
    };
    let result = match_transactions(
        &[tx("tx-001", "2024-12-15", "PAYWAVE.NET CHARGE", -1200)],
        &[r],
        &rules,
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Matched);
    assert!(t.notes.starts_with("rule_match"));
}

#[test]
fn rule_takes_priority_over_amount_match() {
    let rules = [rule("1", "postbox", "paywave")];
    let receipts = [
        with_vendor(eur("/r/postbox.pdf", 999), "Postbox Pty Ltd"),
        with_vendor(eur("/r/exact.pdf", 1200), "Someone Else"),
    ];
    let result = match_transactions(
        &[tx("tx-001", "2024-12-15", "PAYWAVE.NET CHARGE", -1200)],
        &receipts,
        &rules,
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Matched);
    assert!(t.notes.starts_with("rule_match"));
    assert_eq!(t.receipt_files, strings(&["/r/postbox.pdf"]));
}

// matchTransactions > date tiebreaker

fn dated_eur(file: &str, amount_cents: i64, date: Option<&str>) -> ReceiptMeta {
    receipt(file, Some(amount_cents), date, Some("EUR"))
}

#[test]
fn picks_the_closer_dated_receipt_when_name_amount_has_2_candidates() {
    let result = run(
        &[tx("tx-001", "2025-11-14", "COGITO SUBSCRIPTION", -2000)],
        &[
            with_vendor(
                dated_eur("/r/cogito-oct.pdf", 2000, Some("2025-10-14")),
                "Cogito",
            ),
            with_vendor(
                dated_eur("/r/cogito-nov.pdf", 2000, Some("2025-11-13")),
                "Cogito",
            ),
        ],
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Matched);
    assert_eq!(t.receipt_files, strings(&["/r/cogito-nov.pdf"]));
    assert_eq!(t.notes, "name_amount_date_match");
}

#[test]
fn picks_the_closer_dated_receipt_when_amount_only_has_2_candidates() {
    let result = run(
        &[tx("tx-001", "2025-11-14", "COMPRA", -2000)],
        &[
            dated_eur("/r/a.pdf", 2000, Some("2025-09-01")),
            dated_eur("/r/b.pdf", 2000, Some("2025-11-10")),
        ],
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Matched);
    assert_eq!(t.receipt_files, strings(&["/r/b.pdf"]));
    assert_eq!(t.notes, "amount_date_match");
}

#[test]
fn falls_back_to_review_when_both_candidates_are_outside_the_date_window() {
    let result = run(
        &[tx("tx-001", "2025-11-14", "COGITO", -2000)],
        &[
            with_vendor(dated_eur("/r/old.pdf", 2000, Some("2024-01-01")), "Cogito"),
            with_vendor(
                dated_eur("/r/older.pdf", 2000, Some("2023-06-01")),
                "Cogito",
            ),
        ],
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Review);
    assert_eq!(t.receipt_files, strings(&["/r/old.pdf", "/r/older.pdf"]));
}

#[test]
fn falls_back_to_review_when_no_candidate_has_a_date() {
    let result = run(
        &[tx("tx-001", "2025-11-14", "COGITO", -2000)],
        &[
            with_vendor(dated_eur("/r/a.pdf", 2000, None), "Cogito"),
            with_vendor(dated_eur("/r/b.pdf", 2000, None), "Cogito"),
        ],
    );
    assert_eq!(result.transactions[0].status, Status::Review);
}

#[test]
fn treats_two_candidates_with_identical_date_proximity_as_ambiguous() {
    let result = run(
        &[tx("tx-001", "2025-11-14", "COGITO", -2000)],
        &[
            with_vendor(dated_eur("/r/a.pdf", 2000, Some("2025-11-13")), "Cogito"),
            with_vendor(dated_eur("/r/b.pdf", 2000, Some("2025-11-15")), "Cogito"),
        ],
    );
    assert_eq!(result.transactions[0].status, Status::Review);
}

#[test]
fn orders_review_candidates_by_date_proximity_closest_first() {
    let result = run(
        &[tx("tx-001", "2025-11-14", "COGITO", -2000)],
        &[
            with_vendor(dated_eur("/r/far.pdf", 2000, Some("2024-01-01")), "Cogito"),
            with_vendor(dated_eur("/r/near.pdf", 2000, Some("2024-02-01")), "Cogito"),
        ],
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Review);
    assert_eq!(t.receipt_files[0], "/r/near.pdf");
}

// matchTransactions > empty inputs

#[test]
fn handles_no_transactions() {
    let result = run(&[], &[eur("/r/a.pdf", 5000)]);
    assert_eq!(result.transactions.len(), 0);
    assert_eq!(result.receipts_by_status.unmatched, strings(&["/r/a.pdf"]));
}

#[test]
fn handles_no_transactions_and_no_receipts() {
    let result = run(&[], &[]);
    assert_eq!(result.transactions.len(), 0);
    assert!(result.receipts_by_status.matched.is_empty());
}

// match CLI (matching behaviour only)

#[test]
fn outputs_valid_json_match_result() {
    let r = ReceiptMeta {
        currency: None,
        ..eur("/r/a.pdf", 5000)
    };
    let result = run(&[tx("tx-001", "2025-01-15", "COMPRA LOJA", -5000)], &[r]);
    let json = serde_json::to_value(&result).unwrap();
    assert!(json["transactions"].is_array());
    assert!(json["receiptsByStatus"].is_object());
    assert_eq!(result.transactions.len(), 1);
}

#[test]
fn matches_a_transaction_to_a_receipt_by_amount() {
    let result = run(
        &[tx("tx-001", "2025-01-15", "COMPRA", -4599)],
        &[eur("/r/receipt.pdf", 4599)],
    );
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Matched);
    assert_eq!(t.receipt_files, strings(&["/r/receipt.pdf"]));
    assert_eq!(t.notes, "amount_match");
}

#[test]
fn returns_unmatched_when_no_receipt_matches() {
    let r = receipt("/r/other.pdf", Some(1000), None, None);
    let result = run(&[tx("tx-001", "2025-01-15", "COMPRA", -9999)], &[r]);
    let t = &result.transactions[0];
    assert_eq!(t.status, Status::Unmatched);
    assert!(t.receipt_files.is_empty());
}

#[test]
fn handles_empty_transactions_and_receipts() {
    let result = run(&[], &[]);
    assert!(result.transactions.is_empty());
    assert!(result.receipts_by_status.matched.is_empty());
    assert!(result.receipts_by_status.review.is_empty());
    assert!(result.receipts_by_status.unmatched.is_empty());
}

#[test]
fn includes_receipts_by_status_with_correct_categorization() {
    let result = run(
        &[tx("tx-001", "2025-01-15", "COMPRA A", -5000)],
        &[eur("/r/matched.pdf", 5000), eur("/r/extra.pdf", 9999)],
    );
    assert_eq!(
        result.receipts_by_status.matched,
        strings(&["/r/matched.pdf"])
    );
    assert_eq!(
        result.receipts_by_status.unmatched,
        strings(&["/r/extra.pdf"])
    );
}
