//! The Gemini client against a mock Google: token exchange, request shape, reply parsing,
//! the retry prompt and error mapping.

mod common;

use std::net::TcpListener;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use concilia_lib::gemini::client::{
    signed_jwt, GeminiClient, GeminiConfig, GeminiError, Payload, ServiceAccount, DEFAULT_LOCATION,
    DEFAULT_MODEL,
};
use concilia_lib::gemini::parse::Extracted;
use concilia_lib::gemini::prompt::{RECEIPT_PROMPT, RETRY_PROMPT};
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use percent_encoding::percent_decode_str;
use rsa::pkcs8::{DecodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{json, Value};
use wiremock::matchers::{header, method, path};
use wiremock::{Match, Mock, MockServer, Request, ResponseTemplate};

const CLIENT_EMAIL: &str = "tester@acme-test.iam.gserviceaccount.com";
const TOKEN: &str = "test-access-token";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform";
const GENERATE_PATH: &str = "/v1beta1/projects/acme-test/locations/europe-west1/publishers/google/models/gemini-2.5-flash:generateContent";

/// Matches a `generateContent` request whose first text part starts with the given prompt.
struct PromptStartsWith(&'static str);

impl Match for PromptStartsWith {
    fn matches(&self, request: &Request) -> bool {
        let body: Value = match serde_json::from_slice(&request.body) {
            Ok(body) => body,
            Err(_) => return false,
        };
        body.pointer("/contents/0/parts/0/text")
            .and_then(Value::as_str)
            .is_some_and(|text| text.starts_with(self.0))
    }
}

fn config() -> GeminiConfig {
    GeminiConfig {
        project: "acme-test".into(),
        location: DEFAULT_LOCATION.into(),
        model: DEFAULT_MODEL.into(),
    }
}

fn client_for(token_url: String, api_base: String) -> GeminiClient {
    GeminiClient::with_endpoints(common::service_account(), config(), token_url, api_base)
        .expect("client builds")
}

fn client(server: &MockServer) -> GeminiClient {
    client_for(format!("{}/token", server.uri()), server.uri())
}

fn text_payload() -> Payload {
    Payload::Text("ACME CORP\nTOTAL 12,50 EUR".into())
}

/// A Gemini reply whose first candidate carries `text`.
fn reply(text: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({
        "candidates": [{ "content": { "parts": [{ "text": text }] } }]
    }))
}

async fn mount_token(server: &MockServer, expected_calls: u64) {
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": TOKEN,
            "expires_in": 3600,
            "token_type": "Bearer",
        })))
        .expect(expected_calls)
        .mount(server)
        .await;
}

async fn mount_generate(server: &MockServer, response: ResponseTemplate, expected_calls: u64) {
    Mock::given(method("POST"))
        .and(path(GENERATE_PATH))
        .respond_with(response)
        .expect(expected_calls)
        .mount(server)
        .await;
}

/// A local address with nothing listening on it.
fn dead_address() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind a free port");
    let port = listener.local_addr().expect("local address").port();
    drop(listener);
    format!("http://127.0.0.1:{port}")
}

fn form_fields(body: &[u8]) -> Vec<(String, String)> {
    let body = std::str::from_utf8(body).expect("form body is UTF-8");
    body.split('&')
        .map(|pair| {
            let (key, value) = pair.split_once('=').expect("form pair");
            let decode = |s: &str| {
                percent_decode_str(&s.replace('+', " "))
                    .decode_utf8()
                    .expect("form value is UTF-8")
                    .into_owned()
            };
            (decode(key), decode(value))
        })
        .collect()
}

fn decode_segment(segment: &str) -> Value {
    let bytes = URL_SAFE_NO_PAD.decode(segment).expect("base64url segment");
    serde_json::from_slice(&bytes).expect("segment is JSON")
}

fn public_key_pem() -> String {
    let private = rsa::RsaPrivateKey::from_pkcs8_pem(&common::service_account().private_key)
        .expect("test key parses");
    private
        .to_public_key()
        .to_public_key_pem(LineEnding::LF)
        .expect("public key encodes")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_secs()
}

async fn generate_bodies(server: &MockServer) -> Vec<Value> {
    server
        .received_requests()
        .await
        .expect("request recording is on")
        .into_iter()
        .filter(|r| r.url.path() == GENERATE_PATH)
        .map(|r| serde_json::from_slice(&r.body).expect("generate body is JSON"))
        .collect()
}

#[test]
fn service_account_parse_accepts_the_test_key() {
    let account = ServiceAccount::parse(common::service_account_json()).expect("parses");
    assert_eq!(account.client_email, CLIENT_EMAIL);
    assert_eq!(account.project_id.as_deref(), Some("acme-test"));
    assert!(account.private_key.contains("PRIVATE KEY"));
}

#[test]
fn service_account_parse_rejects_malformed_keys() {
    let valid: Value = serde_json::from_str(common::service_account_json()).unwrap();
    let with = |key: &str, value: Value| {
        let mut json = valid.clone();
        json[key] = value;
        json.to_string()
    };
    let without = |key: &str| {
        let mut json = valid.clone();
        json.as_object_mut().unwrap().remove(key);
        json.to_string()
    };

    let cases = [
        ("not JSON", "not json".to_string()),
        ("JSON array", "[]".to_string()),
        ("wrong type", with("type", json!("authorized_user"))),
        ("missing type", without("type")),
        ("missing client_email", without("client_email")),
        ("missing private_key", without("private_key")),
        ("empty client_email", with("client_email", json!("   "))),
        (
            "non-RSA private_key",
            with("private_key", json!("EXAMPLE NOT A KEY")),
        ),
        ("numeric client_email", with("client_email", json!(42))),
    ];
    for (label, json) in cases {
        match ServiceAccount::parse(&json) {
            Err(GeminiError::Invalid(_)) => {}
            other => panic!("{label}: expected Err(Invalid), got {other:?}"),
        }
    }
}

#[test]
fn service_account_debug_hides_the_private_key() {
    let debug = format!("{:?}", common::service_account());
    assert!(debug.contains(CLIENT_EMAIL));
    assert!(!debug.contains("PRIVATE KEY"));
}

#[test]
fn defaults_match_the_original_provider() {
    assert_eq!(DEFAULT_LOCATION, "europe-west1");
    assert_eq!(DEFAULT_MODEL, "gemini-2.5-flash");
}

#[test]
fn signed_jwt_has_header_and_claims_for_the_token_exchange() {
    let jwt = signed_jwt(&common::service_account(), 1_900_000_000).expect("signs");
    let segments: Vec<&str> = jwt.split('.').collect();
    assert_eq!(segments.len(), 3, "JWT has three segments");

    let header = decode_segment(segments[0]);
    assert_eq!(header["alg"], "RS256");
    assert_eq!(header["typ"], "JWT");

    let claims = decode_segment(segments[1]);
    assert_eq!(claims["iss"], CLIENT_EMAIL);
    assert_eq!(claims["sub"], CLIENT_EMAIL);
    assert_eq!(claims["aud"], GOOGLE_TOKEN_URL);
    assert_eq!(claims["scope"], SCOPE);
    assert_eq!(claims["iat"], 1_900_000_000u64);
    assert_eq!(claims["exp"], 1_900_003_600u64);
}

#[tokio::test]
async fn token_exchange_posts_a_signed_jwt_bearer_assertion() {
    let server = MockServer::start().await;
    mount_token(&server, 1).await;

    let before = now_secs();
    client(&server)
        .check()
        .await
        .expect("token exchange succeeds");
    let after = now_secs();

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.url.path(), "/token");
    let content_type = request
        .headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert!(
        content_type.starts_with("application/x-www-form-urlencoded"),
        "content type: {content_type}"
    );

    let fields = form_fields(&request.body);
    let field = |name: &str| {
        fields
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
            .unwrap_or_else(|| panic!("form has no {name}"))
    };
    assert_eq!(
        field("grant_type"),
        "urn:ietf:params:oauth:grant-type:jwt-bearer"
    );

    let assertion = field("assertion");
    let segments: Vec<&str> = assertion.split('.').collect();
    assert_eq!(segments.len(), 3);
    let header = decode_segment(segments[0]);
    assert_eq!(header["alg"], "RS256");
    assert_eq!(header["typ"], "JWT");

    let claims = decode_segment(segments[1]);
    assert_eq!(claims["iss"], CLIENT_EMAIL);
    assert_eq!(claims["sub"], CLIENT_EMAIL);
    assert_eq!(claims["aud"], GOOGLE_TOKEN_URL);
    assert_eq!(claims["scope"], SCOPE);
    let iat = claims["iat"].as_u64().expect("iat is a number");
    let exp = claims["exp"].as_u64().expect("exp is a number");
    assert!((before..=after).contains(&iat), "iat {iat} is now");
    assert_eq!(exp, iat + 3600);

    let key = DecodingKey::from_rsa_pem(public_key_pem().as_bytes()).expect("public key");
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[GOOGLE_TOKEN_URL]);
    validation.set_issuer(&[CLIENT_EMAIL]);
    let verified =
        jsonwebtoken::decode::<Value>(&assertion, &key, &validation).expect("signature verifies");
    assert_eq!(verified.claims["sub"], CLIENT_EMAIL);
}

#[tokio::test]
async fn token_is_fetched_once_and_reused() {
    let server = MockServer::start().await;
    mount_token(&server, 1).await;
    mount_generate(&server, reply(r#"{"amount": 10.00}"#), 2).await;

    let client = client(&server);
    client.extract(&text_payload()).await.unwrap();
    client.extract(&text_payload()).await.unwrap();
}

#[tokio::test]
async fn generate_request_has_the_url_auth_and_text_body() {
    let server = MockServer::start().await;
    mount_token(&server, 1).await;
    Mock::given(method("POST"))
        .and(path(GENERATE_PATH))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(reply(r#"{"amount": 12.5, "currency": "EUR"}"#))
        .expect(1)
        .mount(&server)
        .await;

    let text = "ACME CORP\nTOTAL 12,50 EUR";
    client(&server)
        .extract(&Payload::Text(text.into()))
        .await
        .expect("extracts");

    let bodies = generate_bodies(&server).await;
    assert_eq!(bodies.len(), 1);
    let body = &bodies[0];
    assert_eq!(body["contents"][0]["role"], "user");
    let parts = body["contents"][0]["parts"].as_array().unwrap();
    assert_eq!(parts.len(), 1);
    assert_eq!(
        parts[0]["text"],
        format!("{RECEIPT_PROMPT}\n\nReceipt text:\n{text}")
    );
    assert_eq!(body["generationConfig"]["maxOutputTokens"], 1024);
}

#[tokio::test]
async fn generate_request_attaches_an_image() {
    let server = MockServer::start().await;
    mount_token(&server, 1).await;
    mount_generate(&server, reply(r#"{"amount": 35.00, "currency": "USD"}"#), 1).await;

    let result = client(&server)
        .extract(&Payload::Image {
            base64: "AAAA".into(),
            mime_type: "image/jpeg",
        })
        .await
        .expect("extracts");
    assert_eq!(result.map(|e| e.amount_cents), Some(3500));

    let bodies = generate_bodies(&server).await;
    let body = &bodies[0];
    assert_eq!(body["contents"][0]["role"], "user");
    let parts = body["contents"][0]["parts"].as_array().unwrap();
    assert_eq!(parts.len(), 2);
    assert_eq!(parts[0]["text"], RECEIPT_PROMPT);
    assert_eq!(parts[1]["inline_data"]["mime_type"], "image/jpeg");
    assert_eq!(parts[1]["inline_data"]["data"], "AAAA");
    assert_eq!(body["generationConfig"]["maxOutputTokens"], 1024);
}

#[tokio::test]
async fn parses_the_reply_into_extracted_fields() {
    let server = MockServer::start().await;
    mount_token(&server, 1).await;
    mount_generate(&server, reply(r#"{"amount": 12.5, "currency": "EUR"}"#), 1).await;

    let result = client(&server).extract(&text_payload()).await;
    assert_eq!(
        result,
        Ok(Some(Extracted {
            amount_cents: 1250,
            currency: Some("EUR".into()),
            vendor: None,
            date: None,
        }))
    );
}

#[tokio::test]
async fn parses_vendor_and_date_from_a_wrapped_reply() {
    let server = MockServer::start().await;
    mount_token(&server, 1).await;
    mount_generate(
        &server,
        reply("```json\n{\"amount\": 100.00, \"currency\": \"eur\", \"vendor\": \"ACME CORP\", \"date\": \"2030-03-01\"}\n```"),
        1,
    )
    .await;

    let result = client(&server).extract(&text_payload()).await;
    assert_eq!(
        result,
        Ok(Some(Extracted {
            amount_cents: 10000,
            currency: Some("EUR".into()),
            vendor: Some("ACME CORP".into()),
            date: Some("2030-03-01".into()),
        }))
    );
}

#[tokio::test]
async fn unparseable_reply_is_retried_with_the_short_prompt() {
    let server = MockServer::start().await;
    mount_token(&server, 1).await;
    Mock::given(method("POST"))
        .and(path(GENERATE_PATH))
        .and(PromptStartsWith(RECEIPT_PROMPT))
        .respond_with(reply("I cannot read this receipt"))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path(GENERATE_PATH))
        .and(PromptStartsWith(RETRY_PROMPT))
        .respond_with(reply(r#"{"amount": 20.00, "currency": "EUR"}"#))
        .expect(1)
        .mount(&server)
        .await;

    let result = client(&server).extract(&text_payload()).await;
    assert_eq!(
        result,
        Ok(Some(Extracted {
            amount_cents: 2000,
            currency: Some("EUR".into()),
            vendor: None,
            date: None,
        }))
    );

    let bodies = generate_bodies(&server).await;
    assert_eq!(bodies.len(), 2);
    assert_eq!(
        bodies[1]["contents"][0]["parts"][0]["text"],
        format!("{RETRY_PROMPT}\n\nReceipt text:\nACME CORP\nTOTAL 12,50 EUR")
    );
}

#[tokio::test]
async fn two_unparseable_replies_return_none() {
    let server = MockServer::start().await;
    mount_token(&server, 1).await;
    Mock::given(method("POST"))
        .and(path(GENERATE_PATH))
        .and(PromptStartsWith(RECEIPT_PROMPT))
        .respond_with(reply("I cannot read this receipt"))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path(GENERATE_PATH))
        .and(PromptStartsWith(RETRY_PROMPT))
        .respond_with(reply(r#"{"error": "unreadable"}"#))
        .expect(1)
        .mount(&server)
        .await;

    assert_eq!(client(&server).extract(&text_payload()).await, Ok(None));
}

#[tokio::test]
async fn reply_without_candidates_is_retried_then_none() {
    let server = MockServer::start().await;
    mount_token(&server, 1).await;
    mount_generate(
        &server,
        ResponseTemplate::new(200)
            .set_body_json(json!({ "candidates": [{ "finishReason": "SAFETY" }] })),
        2,
    )
    .await;

    assert_eq!(client(&server).extract(&text_payload()).await, Ok(None));
}

#[tokio::test]
async fn rate_limit_and_server_errors_return_none_without_retrying() {
    for status in [429, 500, 503] {
        let server = MockServer::start().await;
        mount_token(&server, 1).await;
        mount_generate(
            &server,
            ResponseTemplate::new(status).set_body_string("EXAMPLE ERROR"),
            1,
        )
        .await;

        assert_eq!(
            client(&server).extract(&text_payload()).await,
            Ok(None),
            "HTTP {status}"
        );
    }
}

#[tokio::test]
async fn forbidden_generate_is_an_auth_error() {
    let server = MockServer::start().await;
    mount_token(&server, 1).await;
    mount_generate(
        &server,
        ResponseTemplate::new(403).set_body_string("EXAMPLE DENIED"),
        1,
    )
    .await;

    match client(&server).extract(&text_payload()).await {
        Err(GeminiError::Auth(message)) => {
            assert!(message.contains("EXAMPLE DENIED"), "{message}")
        }
        other => panic!("expected Err(Auth), got {other:?}"),
    }
}

#[tokio::test]
async fn unauthorized_generate_gets_a_new_token_and_one_more_try() {
    let server = MockServer::start().await;
    mount_token(&server, 2).await;
    Mock::given(method("POST"))
        .and(path(GENERATE_PATH))
        .respond_with(ResponseTemplate::new(401))
        .up_to_n_times(1)
        .expect(1)
        .mount(&server)
        .await;
    mount_generate(&server, reply(r#"{"amount": 12.5}"#), 1).await;

    let found = client(&server).extract(&text_payload()).await;
    assert_eq!(found.map(|e| e.map(|e| e.amount_cents)), Ok(Some(1250)));
}

#[tokio::test]
async fn a_second_unauthorized_generate_is_an_auth_error() {
    let server = MockServer::start().await;
    mount_token(&server, 2).await;
    mount_generate(
        &server,
        ResponseTemplate::new(401).set_body_string("EXAMPLE DENIED"),
        2,
    )
    .await;

    match client(&server).extract(&text_payload()).await {
        Err(GeminiError::Auth(message)) => {
            assert!(message.contains("EXAMPLE DENIED"), "{message}")
        }
        other => panic!("expected Err(Auth), got {other:?}"),
    }
}

#[tokio::test]
async fn unauthorized_generate_makes_test_connection_fetch_a_new_token() {
    let server = MockServer::start().await;
    mount_token(&server, 2).await;
    mount_generate(&server, ResponseTemplate::new(401), 2).await;

    let client = client(&server);
    let _ = client.extract(&text_payload()).await;
    assert_eq!(client.check().await, Ok(()));
}

#[tokio::test]
async fn refused_token_exchange_is_an_auth_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(400).set_body_string(r#"{"error":"invalid_grant"}"#))
        .expect(2)
        .mount(&server)
        .await;
    mount_generate(&server, reply(r#"{"amount": 1}"#), 0).await;

    let client = client(&server);
    assert!(matches!(client.check().await, Err(GeminiError::Auth(_))));
    assert!(matches!(
        client.extract(&text_payload()).await,
        Err(GeminiError::Auth(_))
    ));
}

#[tokio::test]
async fn token_reply_without_access_token_is_an_auth_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "token_type": "Bearer" })))
        .mount(&server)
        .await;

    assert!(matches!(
        client(&server).check().await,
        Err(GeminiError::Auth(_))
    ));
}

#[tokio::test]
async fn unreachable_token_server_is_a_network_error() {
    let dead = dead_address();
    let client = client_for(format!("{dead}/token"), dead);
    assert!(matches!(client.check().await, Err(GeminiError::Network(_))));
    assert!(matches!(
        client.extract(&text_payload()).await,
        Err(GeminiError::Network(_))
    ));
}

#[tokio::test]
async fn unreachable_api_server_is_a_network_error() {
    let server = MockServer::start().await;
    mount_token(&server, 1).await;
    let client = client_for(format!("{}/token", server.uri()), dead_address());
    assert!(matches!(
        client.extract(&text_payload()).await,
        Err(GeminiError::Network(_))
    ));
}
