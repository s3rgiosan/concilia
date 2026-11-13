//! What the Gemini extractor sends for each kind of receipt file, against a mock server.
//! The PDF cases need poppler and skip themselves without it.

mod common;

use std::sync::Arc;

use concilia_lib::extract::{ExtractError, GeminiExtractor, ReceiptExtractor};
use concilia_lib::gemini::client::{GeminiClient, GeminiConfig, RetryPolicy};
use concilia_lib::poppler::Poppler;
use serde_json::{json, Value};
use wiremock::matchers::{method, path, path_regex};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

fn reply(text: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({
        "candidates": [{ "content": { "parts": [{ "text": text }] } }]
    }))
}

async fn server() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({ "access_token": "test-token" })),
        )
        .mount(&server)
        .await;
    server
}

fn extractor(server: &MockServer, poppler: Poppler) -> GeminiExtractor {
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
    .unwrap()
    .with_retry_policy(RetryPolicy::immediate());
    GeminiExtractor {
        client: Arc::new(client),
        poppler,
    }
}

async fn generate_requests(server: &MockServer) -> Vec<Value> {
    server
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .filter(|r: &&Request| r.url.path().ends_with(":generateContent"))
        .map(|r| serde_json::from_slice(&r.body).unwrap())
        .collect()
}

fn no_poppler() -> Poppler {
    Poppler {
        pdftotext: "/nonexistent/pdftotext".into(),
        pdftoppm: "/nonexistent/pdftoppm".into(),
        bundled: false,
    }
}

#[tokio::test]
async fn sends_image_files_as_images() {
    let server = server().await;
    Mock::given(path_regex(":generateContent$"))
        .respond_with(reply(
            r#"{"amount": 10.00, "currency": "EUR", "vendor": "ACME", "date": "2030-03-01"}"#,
        ))
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("acme.JPG");
    std::fs::write(&file, b"\xFF\xD8\xFFjpeg bytes").unwrap();

    let meta = extractor(&server, no_poppler())
        .extract(&file)
        .await
        .unwrap();
    assert_eq!(meta.amount_cents, Some(1000));
    assert_eq!(meta.confidence.as_deref(), Some("high"));
    assert_eq!(meta.vendor.as_deref(), Some("ACME"));
    assert_eq!(meta.date.as_deref(), Some("2030-03-01"));
    assert_eq!(meta.provider_used.as_deref(), Some("gemini"));
    assert_eq!(meta.file, file.to_string_lossy());

    let requests = generate_requests(&server).await;
    let image = &requests[0]["contents"][0]["parts"][1]["inline_data"];
    assert_eq!(image["mime_type"], "image/jpeg");
    assert_eq!(image["data"], "/9j/anBlZyBieXRlcw==");
}

#[tokio::test]
async fn sends_readable_pdfs_as_text() {
    let Some(poppler) = common::poppler_on_path() else {
        return;
    };
    let server = server().await;
    Mock::given(path_regex(":generateContent$"))
        .respond_with(reply(r#"{"amount": 10.00, "currency": "EUR"}"#))
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("acme.pdf");
    std::fs::write(
        &file,
        common::pdf_with_lines(&["ACME CORP", "TOTAL 10,00 EUR"]),
    )
    .unwrap();

    let meta = extractor(&server, poppler).extract(&file).await.unwrap();
    assert_eq!(meta.amount_cents, Some(1000));
    let requests = generate_requests(&server).await;
    assert_eq!(requests.len(), 1);
    let parts = requests[0]["contents"][0]["parts"].as_array().unwrap();
    assert_eq!(parts.len(), 1);
    let text = parts[0]["text"].as_str().unwrap();
    assert!(text.contains("\n\nReceipt text:\n"), "{text}");
    assert!(text.contains("TOTAL 10,00 EUR"), "{text}");
}

#[tokio::test]
async fn renders_pdfs_without_usable_text() {
    let Some(poppler) = common::poppler_on_path() else {
        return;
    };
    let server = server().await;
    Mock::given(path_regex(":generateContent$"))
        .respond_with(reply(r#"{"amount": 5.00}"#))
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("scan.pdf");
    std::fs::write(&file, common::pdf_with_lines(&["ACME CORP RECEIPT"])).unwrap();

    let meta = extractor(&server, poppler).extract(&file).await.unwrap();
    assert_eq!(meta.amount_cents, Some(500));
    assert_eq!(meta.currency, None);
    let requests = generate_requests(&server).await;
    assert_eq!(
        requests[0]["contents"][0]["parts"][1]["inline_data"]["mime_type"],
        "image/png"
    );
}

#[tokio::test]
async fn falls_back_to_an_image_when_the_text_cannot_be_read() {
    let Some(poppler) = common::poppler_on_path() else {
        return;
    };
    let server = server().await;
    Mock::given(path_regex(":generateContent$"))
        .respond_with(reply("no idea"))
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("acme.pdf");
    std::fs::write(
        &file,
        common::pdf_with_lines(&["ACME CORP", "TOTAL 10,00 EUR"]),
    )
    .unwrap();

    let meta = extractor(&server, poppler).extract(&file).await.unwrap();
    assert_eq!(meta.amount_cents, None);
    assert_eq!(meta.confidence, None);
    assert_eq!(meta.provider_used.as_deref(), Some("gemini"));

    // Text with the main prompt and the retry prompt, then the image with both.
    let requests = generate_requests(&server).await;
    let with_image: Vec<bool> = requests
        .iter()
        .map(|r| r["contents"][0]["parts"].as_array().unwrap().len() == 2)
        .collect();
    assert_eq!(with_image, [false, false, true, true]);
}

#[tokio::test]
async fn stops_on_authorization_failures() {
    let server = server().await;
    Mock::given(path_regex(":generateContent$"))
        .respond_with(ResponseTemplate::new(403).set_body_string("permission denied"))
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("acme.png");
    std::fs::write(&file, b"\x89PNG\r\n\x1a\npng bytes").unwrap();

    let error = extractor(&server, no_poppler())
        .extract(&file)
        .await
        .unwrap_err();
    assert!(matches!(error, ExtractError::Fatal(_)), "{error:?}");
}

#[tokio::test]
async fn stops_on_a_rate_limit_that_retries_do_not_clear() {
    let server = server().await;
    Mock::given(path_regex(":generateContent$"))
        .respond_with(ResponseTemplate::new(429).set_body_string("quota used up"))
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("acme.png");
    std::fs::write(&file, b"\x89PNG\r\n\x1a\npng bytes").unwrap();

    let error = extractor(&server, no_poppler())
        .extract(&file)
        .await
        .unwrap_err();
    match error {
        ExtractError::Service(message) => assert!(message.contains("429"), "{message}"),
        other => panic!("expected Service, got {other:?}"),
    }
}

#[tokio::test]
async fn refuses_the_file_when_gemini_rejects_the_request() {
    for (status, code) in [(400, "gemini_http_400"), (413, "gemini_http_413")] {
        let server = server().await;
        Mock::given(path_regex(":generateContent$"))
            .respond_with(ResponseTemplate::new(status).set_body_string("bad request"))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("acme.png");
        std::fs::write(&file, b"\x89PNG\r\n\x1a\npng bytes").unwrap();

        let error = extractor(&server, no_poppler())
            .extract(&file)
            .await
            .unwrap_err();
        match error {
            ExtractError::Rejected { code: seen, .. } => assert_eq!(seen, code),
            other => panic!("HTTP {status}: expected Rejected, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn stops_when_the_model_is_not_found() {
    let server = server().await;
    Mock::given(path_regex(":generateContent$"))
        .respond_with(ResponseTemplate::new(404).set_body_string("model not found"))
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("acme.png");
    std::fs::write(&file, b"\x89PNG\r\n\x1a\npng bytes").unwrap();

    let error = extractor(&server, no_poppler())
        .extract(&file)
        .await
        .unwrap_err();
    assert!(matches!(error, ExtractError::Service(_)), "{error:?}");
}

#[tokio::test]
async fn does_not_send_the_page_image_after_an_http_error() {
    let Some(poppler) = common::poppler_on_path() else {
        return;
    };
    let server = server().await;
    Mock::given(path_regex(":generateContent$"))
        .respond_with(ResponseTemplate::new(503).set_body_string("unavailable"))
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("acme.pdf");
    std::fs::write(
        &file,
        common::pdf_with_lines(&["ACME CORP", "TOTAL 10,00 EUR"]),
    )
    .unwrap();

    let error = extractor(&server, poppler)
        .extract(&file)
        .await
        .unwrap_err();
    assert!(matches!(error, ExtractError::Service(_)), "{error:?}");
    let requests = generate_requests(&server).await;
    assert_eq!(requests.len(), 4);
    for request in &requests {
        assert_eq!(request["contents"][0]["parts"].as_array().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn reports_unreadable_files_as_failed_attempts() {
    let server = server().await;
    let error = extractor(&server, no_poppler())
        .extract(std::path::Path::new("/nonexistent/acme.png"))
        .await
        .unwrap_err();
    assert!(matches!(error, ExtractError::Failed(_)), "{error:?}");
}

#[tokio::test]
async fn refuses_files_whose_contents_do_not_match_their_type() {
    let server = server().await;
    let dir = tempfile::tempdir().unwrap();
    let cases: [(&str, &[u8]); 3] = [
        ("script.pdf", b"#!/bin/sh\necho"),
        ("photo.png", b"%PDF-1.4\n"),
        ("photo.jpg", b"GIF89a"),
    ];
    for (name, bytes) in cases {
        let file = dir.path().join(name);
        std::fs::write(&file, bytes).unwrap();
        let error = extractor(&server, no_poppler())
            .extract(&file)
            .await
            .unwrap_err();
        assert!(
            matches!(
                error,
                ExtractError::Rejected {
                    code: "unrecognized_file",
                    ..
                }
            ),
            "{name}: {error:?}"
        );
    }
    assert!(generate_requests(&server).await.is_empty());
}

#[tokio::test]
async fn sends_a_png_named_jpg_as_a_png() {
    let server = server().await;
    Mock::given(path_regex(":generateContent$"))
        .respond_with(reply(r#"{"amount": 1.00}"#))
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("acme.jpg");
    std::fs::write(&file, b"\x89PNG\r\n\x1a\npng bytes").unwrap();
    extractor(&server, no_poppler())
        .extract(&file)
        .await
        .unwrap();
    let requests = generate_requests(&server).await;
    assert_eq!(
        requests[0]["contents"][0]["parts"][1]["inline_data"]["mime_type"],
        "image/png"
    );
}

#[tokio::test]
async fn refuses_files_over_the_size_limit() {
    let server = server().await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("big.png");
    let handle = std::fs::File::create(&file).unwrap();
    handle
        .set_len(concilia_lib::filecheck::MAX_INPUT_BYTES + 1)
        .unwrap();
    let error = extractor(&server, no_poppler())
        .extract(&file)
        .await
        .unwrap_err();
    assert!(
        matches!(
            error,
            ExtractError::Rejected {
                code: "file_too_large",
                ..
            }
        ),
        "{error:?}"
    );
}
