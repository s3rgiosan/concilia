//! A whole period through the real PDF tools and Gemini client, with Gemini replaced by a mock
//! server: reconcile, review, Finalize. Skipped when poppler is not installed.

mod common;

use std::sync::{Arc, Mutex};

use concilia_lib::bank::Bank;
use concilia_lib::extract::{ExtractOptions, GeminiExtractor};
use concilia_lib::gemini::client::{GeminiClient, GeminiConfig};
use concilia_lib::model::{default_reasons, Language, MatchResult, Status};
use concilia_lib::period::Period;
use concilia_lib::pipeline::{self, RunContext, RunEvent, StatementFile};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path, path_regex};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

/// Answers each receipt by the vendor named in its text.
struct ReceiptReplies;

impl Respond for ReceiptReplies {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let body: Value = serde_json::from_slice(&request.body).unwrap_or_default();
        let prompt = body["contents"][0]["parts"][0]["text"]
            .as_str()
            .unwrap_or_default();
        let answer = if prompt.contains("ACME CORP") {
            r#"{"amount": 10.00, "currency": "EUR", "vendor": "ACME CORP", "date": "2030-03-01"}"#
        } else if prompt.contains("GLOBEX") {
            r#"{"amount": 25.00, "currency": "EUR", "vendor": "GLOBEX", "date": "2030-03-05"}"#
        } else if prompt.contains("TAXI CO") {
            r#"{"amount": 12.50, "currency": "EUR", "vendor": "TAXI CO", "date": "2030-03-07"}"#
        } else {
            r#"{"error": "unreadable"}"#
        };
        ResponseTemplate::new(200).set_body_json(json!({
            "candidates": [{ "content": { "parts": [{ "text": answer }] } }]
        }))
    }
}

#[tokio::test]
async fn reconciles_and_finalizes_a_period() {
    let Some(poppler) = common::poppler_on_path() else {
        eprintln!("poppler not installed; skipping");
        return;
    };
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({ "access_token": "test-token" })),
        )
        .mount(&server)
        .await;
    Mock::given(path_regex(":generateContent$"))
        .respond_with(ReceiptReplies)
        .mount(&server)
        .await;
    let client = GeminiClient::with_endpoints(
        common::service_account(),
        GeminiConfig {
            project: "acme-test".into(),
            location: "europe-west1".into(),
            model: "gemini-test".into(),
        },
        format!("{}/token", server.uri()),
        server.uri(),
    )
    .unwrap();

    let root = tempfile::tempdir().unwrap();
    let paths = Period::parse("2030", "03").unwrap().paths(root.path());
    std::fs::create_dir_all(paths.receipts.join("sub")).unwrap();
    std::fs::create_dir_all(&paths.reimbursements).unwrap();
    std::fs::write(
        paths.receipts.join("acme.pdf"),
        common::pdf_with_lines(&["ACME CORP", "Invoice EXAMPLE-0001", "TOTAL 10,00 EUR"]),
    )
    .unwrap();
    std::fs::write(
        paths.receipts.join("sub/globex.pdf"),
        common::pdf_with_lines(&["GLOBEX", "Receipt 2030-03-05", "TOTAL 25,00 EUR"]),
    )
    .unwrap();
    std::fs::write(
        paths.reimbursements.join("taxi.pdf"),
        common::pdf_with_lines(&["TAXI CO", "Trip 2030-03-07", "TOTAL 12,50 EUR"]),
    )
    .unwrap();
    let statement = root.path().join("statement.pdf");
    std::fs::write(
        &statement,
        common::pdf_with_lines(&[
            "EXTRATO EXAMPLE BANK",
            "  2030-03-01 2030-03-01 ACME CORP              -10,00     990,00",
            "  2030-03-04 2030-03-04 GLOBEX ONLINE          -25,00     965,00",
            "  2030-03-06 2030-03-06 EXAMPLE FEE             -1,00     964,00",
            "  2030-03-08 2030-03-08 INITECH                -40,00     924,00",
        ]),
    )
    .unwrap();

    let extractor = GeminiExtractor {
        client: Arc::new(client),
        poppler: poppler.clone(),
    };
    let events = Mutex::new(Vec::new());
    let progress = |event: RunEvent| events.lock().unwrap().push(event);
    let ctx = RunContext {
        paths: paths.clone(),
        extractor: &extractor,
        statements: &poppler,
        rules: Vec::new(),
        language: Language::Pt,
        reasons: default_reasons(),
        options: ExtractOptions::default(),
        progress: &progress,
        cancel: CancellationToken::new(),
    };
    let summary = pipeline::reconcile(
        &ctx,
        &[StatementFile {
            path: statement,
            bank: Bank::Cgd,
        }],
        false,
    )
    .await
    .unwrap();

    assert_eq!(summary.total_transactions, 4);
    assert_eq!(summary.matched, 3, "{summary:?}");
    assert_eq!(summary.bank_fees, 1);
    assert_eq!(summary.unmatched, 1);
    assert_eq!(summary.total_receipts, 2);
    assert!(events.lock().unwrap().contains(&RunEvent::Exporting));

    let result: MatchResult = common::read_json_file(&paths.match_result());
    let by_description = |d: &str| {
        result
            .transactions
            .iter()
            .find(|t| t.description == d)
            .unwrap()
    };
    assert_eq!(by_description("ACME CORP").status, Status::Matched);
    assert_eq!(by_description("GLOBEX ONLINE").status, Status::Matched);
    assert_eq!(by_description("EXAMPLE FEE").notes, "bank_fee");
    assert_eq!(by_description("INITECH").status, Status::Unmatched);
    let names = common::report_sheet_names(&paths.report());
    assert_eq!(
        names,
        [
            "Totais",
            "Todas as transações",
            "Associados",
            "Por rever",
            "Sem associação",
            "Reembolsos"
        ]
    );

    pipeline::finalize(&paths, Language::Pt, &default_reasons()).unwrap();
    assert!(paths.receipts.join("_matched/acme.pdf").is_file());
    assert!(paths.receipts.join("_matched/globex.pdf").is_file());
    assert!(paths.applied_marker().is_file());
    let finalized: MatchResult = pipeline::stored::read_stored(&paths.dir, &paths.match_result())
        .unwrap()
        .unwrap();
    for file in finalized.receipts_by_status.matched {
        assert!(std::path::Path::new(&file).is_file(), "{file}");
    }
}
