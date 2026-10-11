//! Gemini on Google's Gemini Enterprise Agent Platform, authenticated with a Google service
//! account.

use std::borrow::Cow;
use std::sync::LazyLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use jsonwebtoken::{Algorithm, EncodingKey, Header};
use regex::Regex;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::parse::{parse_json_from_text, Extracted};
use super::prompt::{RECEIPT_PROMPT, RETRY_PROMPT};

pub const DEFAULT_LOCATION: &str = "europe-west1";
pub const DEFAULT_MODEL: &str = "gemini-2.5-flash";
/// The region served by the global endpoint, `aiplatform.googleapis.com`.
pub const GLOBAL_LOCATION: &str = "global";
/// Every API host ends with this; requests carrying the access token go nowhere else.
const API_HOST_SUFFIX: &str = "aiplatform.googleapis.com";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_TIMEOUT: Duration = Duration::from_secs(15);
const GENERATE_TIMEOUT: Duration = Duration::from_secs(120);
const TOKEN_LIFETIME: Duration = Duration::from_secs(3600);
/// A cached token is renewed when it has less than this left.
const TOKEN_MARGIN: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GeminiError {
    /// The service account or the project was refused. Every request would fail the same way.
    #[error("Google rejected the service account: {0}")]
    Auth(String),
    #[error("could not reach Google: {0}")]
    Network(String),
    #[error("{0}")]
    Invalid(String),
    /// A region, project or model that cannot be part of the API address.
    #[error("{0}")]
    Setting(InvalidSetting),
}

/// A Gemini setting with characters or a shape Google never uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum InvalidSetting {
    #[error("the region must look like europe-west1, or be global")]
    Region,
    #[error("the project ID must be 6 to 30 lowercase letters, digits or hyphens, starting with a letter")]
    Project,
    #[error("the model name may only contain letters, digits, dots, hyphens and underscores")]
    Model,
}

impl InvalidSetting {
    /// The code the frontend words this case by.
    pub fn code(self) -> &'static str {
        match self {
            InvalidSetting::Region => "invalid_region",
            InvalidSetting::Project => "invalid_project",
            InvalidSetting::Model => "invalid_model",
        }
    }
}

static REGION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z]+-[a-z]+[0-9]+$").expect("pattern compiles"));
static PROJECT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$").expect("pattern compiles"));
static MODEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._-]+$").expect("pattern compiles"));

/// Checks a region such as `europe-west1`, or `global`.
pub fn check_location(location: &str) -> Result<(), InvalidSetting> {
    if location == GLOBAL_LOCATION || REGION.is_match(location) {
        Ok(())
    } else {
        Err(InvalidSetting::Region)
    }
}

/// Checks a Google Cloud project ID.
pub fn check_project(project: &str) -> Result<(), InvalidSetting> {
    if PROJECT.is_match(project) {
        Ok(())
    } else {
        Err(InvalidSetting::Project)
    }
}

/// Checks a model name such as `gemini-2.5-flash`.
pub fn check_model(model: &str) -> Result<(), InvalidSetting> {
    if MODEL.is_match(model) {
        Ok(())
    } else {
        Err(InvalidSetting::Model)
    }
}

/// The fields of a service account key file that Concilia uses.
#[derive(Clone, Deserialize)]
pub struct ServiceAccount {
    pub client_email: String,
    pub private_key: String,
    #[serde(default)]
    pub project_id: Option<String>,
}

impl std::fmt::Debug for ServiceAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServiceAccount")
            .field("client_email", &self.client_email)
            .field("project_id", &self.project_id)
            .finish_non_exhaustive()
    }
}

impl ServiceAccount {
    /// Reads a key file's JSON, checking it is a service account key with an email and an
    /// RSA private key.
    pub fn parse(json: &str) -> Result<ServiceAccount, GeminiError> {
        let value: Value = serde_json::from_str(json)
            .map_err(|_| GeminiError::Invalid("the file is not a JSON key file".into()))?;
        let key_type = value.get("type").and_then(Value::as_str);
        if key_type != Some("service_account") {
            return Err(GeminiError::Invalid(
                "the file is not a service account key".into(),
            ));
        }
        let account: ServiceAccount = serde_json::from_value(value).map_err(|_| {
            GeminiError::Invalid("the key file is missing client_email or private_key".into())
        })?;
        if account.client_email.trim().is_empty() {
            return Err(GeminiError::Invalid(
                "the key file has an empty client_email".into(),
            ));
        }
        EncodingKey::from_rsa_pem(account.private_key.as_bytes()).map_err(|_| {
            GeminiError::Invalid("the key file's private_key is not an RSA key".into())
        })?;
        Ok(account)
    }
}

/// Which Google Cloud project, region and model to call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeminiConfig {
    pub project: String,
    pub location: String,
    pub model: String,
}

impl GeminiConfig {
    pub fn validate(&self) -> Result<(), InvalidSetting> {
        check_location(&self.location)?;
        check_project(&self.project)?;
        check_model(&self.model)
    }

    /// The API server for the region: the global endpoint for `global`, the regional one
    /// otherwise.
    fn api_base(&self) -> Result<Url, GeminiError> {
        self.validate().map_err(GeminiError::Setting)?;
        let host = if self.location == GLOBAL_LOCATION {
            API_HOST_SUFFIX.to_string()
        } else {
            format!("{}-{API_HOST_SUFFIX}", self.location)
        };
        let url = Url::parse(&format!("https://{host}"))
            .map_err(|_| GeminiError::Setting(InvalidSetting::Region))?;
        if !is_api_host(&url) {
            return Err(GeminiError::Setting(InvalidSetting::Region));
        }
        Ok(url)
    }
}

/// Whether a URL points at Google's AI Platform API over HTTPS: the global host, or a
/// regional one such as `europe-west1-aiplatform.googleapis.com`.
fn is_api_host(url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default();
    let regional = host
        .strip_suffix(API_HOST_SUFFIX)
        .and_then(|prefix| prefix.strip_suffix('-'))
        .is_some_and(|region| REGION.is_match(region));
    url.scheme() == "https" && (host == API_HOST_SUFFIX || regional)
}

/// What Gemini reads: the receipt's text, or an image of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Payload {
    Text(String),
    Image {
        base64: String,
        mime_type: &'static str,
    },
}

#[derive(Serialize)]
struct Claims<'a> {
    iss: &'a str,
    sub: &'a str,
    aud: &'a str,
    iat: u64,
    exp: u64,
    scope: &'a str,
}

/// Signs the assertion exchanged for an access token.
pub fn signed_jwt(account: &ServiceAccount, now_secs: u64) -> Result<String, GeminiError> {
    let key = EncodingKey::from_rsa_pem(account.private_key.as_bytes())
        .map_err(|e| GeminiError::Invalid(format!("private key: {e}")))?;
    let claims = Claims {
        iss: &account.client_email,
        sub: &account.client_email,
        aud: TOKEN_URL,
        iat: now_secs,
        exp: now_secs + TOKEN_LIFETIME.as_secs(),
        scope: SCOPE,
    };
    jsonwebtoken::encode(&Header::new(Algorithm::RS256), &claims, &key)
        .map_err(|e| GeminiError::Invalid(format!("signing: {e}")))
}

pub struct GeminiClient {
    http: reqwest::Client,
    account: ServiceAccount,
    config: GeminiConfig,
    token_url: String,
    api_base: Url,
    /// Whether every request must go to Google's API host; off only for test servers.
    google_only: bool,
    token: Mutex<Option<(String, Instant)>>,
}

impl GeminiClient {
    /// A client for Google's API. Fails when the region, project or model cannot be part of
    /// the API address.
    pub fn new(account: ServiceAccount, config: GeminiConfig) -> Result<GeminiClient, GeminiError> {
        let api_base = config.api_base()?;
        let mut client =
            GeminiClient::with_endpoints(account, config, TOKEN_URL.into(), api_base.into())?;
        client.google_only = true;
        Ok(client)
    }

    /// A client that talks to other token and API servers, such as a test server.
    pub fn with_endpoints(
        account: ServiceAccount,
        config: GeminiConfig,
        token_url: String,
        api_base: String,
    ) -> Result<GeminiClient, GeminiError> {
        config.validate().map_err(GeminiError::Setting)?;
        let api_base =
            Url::parse(&api_base).map_err(|e| GeminiError::Invalid(format!("API address: {e}")))?;
        let http = reqwest::Client::builder()
            .user_agent(concat!("concilia/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| GeminiError::Invalid(e.to_string()))?;
        Ok(GeminiClient {
            http,
            account,
            config,
            token_url,
            api_base,
            google_only: false,
            token: Mutex::new(None),
        })
    }

    /// Fetches an access token without extracting anything, to check the settings work.
    pub async fn check(&self) -> Result<(), GeminiError> {
        self.access_token().await.map(|_| ())
    }

    async fn access_token(&self) -> Result<String, GeminiError> {
        let mut cached = self.token.lock().await;
        if let Some((token, expires)) = cached.as_ref() {
            let refresh_from = Instant::now() + TOKEN_MARGIN;
            if refresh_from < *expires {
                return Ok(token.clone());
            }
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or_default();
        let assertion = signed_jwt(&self.account, now)?;
        let response = self
            .http
            .post(&self.token_url)
            .timeout(TOKEN_TIMEOUT)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", assertion.as_str()),
            ])
            .send()
            .await
            .map_err(|e| GeminiError::Network(e.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(GeminiError::Auth(format!(
                "token exchange failed ({status}): {body}"
            )));
        }
        let body: Value = response
            .json()
            .await
            .map_err(|e| GeminiError::Auth(format!("token response: {e}")))?;
        let token = body
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or_else(|| GeminiError::Auth("token response has no access_token".into()))?
            .to_string();
        *cached = Some((token.clone(), Instant::now() + TOKEN_LIFETIME));
        Ok(token)
    }

    /// The `generateContent` address, with each setting as one path segment.
    pub fn generate_url(&self) -> Result<Url, GeminiError> {
        let GeminiConfig {
            project,
            location,
            model,
        } = &self.config;
        let mut url = self.api_base.clone();
        url.path_segments_mut()
            .map_err(|_| GeminiError::Invalid("the API address cannot have a path".into()))?
            .pop_if_empty()
            .extend([
                "v1beta1",
                "projects",
                project,
                "locations",
                location,
                "publishers",
                "google",
                "models",
                &format!("{model}:generateContent"),
            ]);
        if self.google_only && !is_api_host(&url) {
            return Err(GeminiError::Setting(InvalidSetting::Region));
        }
        Ok(url)
    }

    /// Sends one request. Returns the reply text, or none when the server answered with an
    /// error other than an authorization failure.
    async fn call(&self, prompt: &str, payload: &Payload) -> Result<Option<String>, GeminiError> {
        let url = self.generate_url()?;
        let token = self.access_token().await?;
        let response = self
            .http
            .post(url)
            .timeout(GENERATE_TIMEOUT)
            .bearer_auth(token)
            .json(&request_body(prompt, payload, &self.config.model))
            .send()
            .await
            .map_err(|e| GeminiError::Network(e.to_string()))?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            let body = response.text().await.unwrap_or_default();
            return Err(GeminiError::Auth(format!(
                "Gemini refused the request ({status}): {body}"
            )));
        }
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            log::warn!("gemini HTTP {status}: {body}");
            return Ok(None);
        }
        let body: Value = response
            .json()
            .await
            .map_err(|e| GeminiError::Network(format!("reply: {e}")))?;
        let text = body
            .pointer("/candidates/0/content/parts/0/text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if text.is_empty() {
            let reason = body
                .pointer("/candidates/0/finishReason")
                .and_then(Value::as_str)
                .unwrap_or("none");
            log::warn!("gemini returned no text (finishReason: {reason})");
        }
        Ok(Some(text.to_string()))
    }

    /// Reads a receipt. A reply without usable JSON gets one more try with a shorter prompt.
    pub async fn extract(&self, payload: &Payload) -> Result<Option<Extracted>, GeminiError> {
        let Some(text) = self.call(RECEIPT_PROMPT, payload).await? else {
            return Ok(None);
        };
        if let Some(found) = parse_json_from_text(&text) {
            return Ok(Some(found));
        }
        log::debug!("gemini reply had no usable JSON, retrying: {text}");
        let Some(retry) = self.call(RETRY_PROMPT, payload).await? else {
            return Ok(None);
        };
        let found = parse_json_from_text(&retry);
        if found.is_none() {
            log::debug!("gemini retry had no usable JSON either: {retry}");
        }
        Ok(found)
    }
}

/// The fields Gemini returns, as an OpenAPI schema: the amount, currency, vendor and date
/// the prompt asks for, and `error` for an unreadable receipt.
static RESPONSE_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    let nullable = |kind: &str| json!({ "type": kind, "nullable": true });
    json!({
        "type": "object",
        "properties": {
            "amount": nullable("number"),
            "currency": nullable("string"),
            "vendor": nullable("string"),
            "date": nullable("string"),
            "error": nullable("string"),
        },
        "required": ["amount"],
    })
});

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerateRequest<'a> {
    contents: [Content<'a>; 1],
    generation_config: GenerationConfig,
}

#[derive(Serialize)]
struct Content<'a> {
    role: &'static str,
    parts: Vec<Part<'a>>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Part<'a> {
    Text { text: Cow<'a, str> },
    Image { inline_data: InlineData<'a> },
}

#[derive(Serialize)]
struct InlineData<'a> {
    mime_type: &'a str,
    data: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerationConfig {
    max_output_tokens: u32,
    response_mime_type: &'static str,
    response_schema: &'static Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking_config: Option<ThinkingConfig>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThinkingConfig {
    thinking_budget: u32,
}

/// The thinking budget for `model`: none for the 2.5 Flash models, which can skip thinking,
/// and the model's own default for any other.
fn thinking_config(model: &str) -> Option<ThinkingConfig> {
    model
        .starts_with("gemini-2.5-flash")
        .then_some(ThinkingConfig { thinking_budget: 0 })
}

/// The `generateContent` request body: the prompt, with the receipt text appended or the
/// image attached, asking for JSON in the shape of `RESPONSE_SCHEMA`.
fn request_body<'a>(prompt: &'a str, payload: &'a Payload, model: &str) -> GenerateRequest<'a> {
    let parts = match payload {
        Payload::Text(text) => vec![Part::Text {
            text: Cow::Owned(format!("{prompt}\n\nReceipt text:\n{text}")),
        }],
        Payload::Image { base64, mime_type } => vec![
            Part::Text {
                text: Cow::Borrowed(prompt),
            },
            Part::Image {
                inline_data: InlineData {
                    mime_type,
                    data: base64,
                },
            },
        ],
    };
    GenerateRequest {
        contents: [Content {
            role: "user",
            parts,
        }],
        generation_config: GenerationConfig {
            max_output_tokens: 1024,
            response_mime_type: "application/json",
            response_schema: &RESPONSE_SCHEMA,
            thinking_config: thinking_config(model),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_files_that_are_not_service_account_keys() {
        assert!(ServiceAccount::parse("not json").is_err());
        assert!(ServiceAccount::parse(r#"{"type":"authorized_user"}"#).is_err());
        assert!(
            ServiceAccount::parse(r#"{"type":"service_account","client_email":"a@b"}"#).is_err()
        );
        assert!(ServiceAccount::parse(
            r#"{"type":"service_account","client_email":"a@b","private_key":"nope"}"#
        )
        .is_err());
    }

    fn body(prompt: &str, payload: &Payload, model: &str) -> Value {
        serde_json::to_value(request_body(prompt, payload, model)).unwrap()
    }

    fn config(location: &str, project: &str, model: &str) -> GeminiConfig {
        GeminiConfig {
            project: project.into(),
            location: location.into(),
            model: model.into(),
        }
    }

    #[test]
    fn checks_regions() {
        for ok in [
            "europe-west1",
            "us-central1",
            "northamerica-northeast2",
            "global",
        ] {
            assert_eq!(check_location(ok), Ok(()), "{ok}");
        }
        for bad in [
            "",
            "europe",
            "Europe-west1",
            "europe-west",
            "evil.com/x",
            "europe-west1.evil.com",
            "europe-west1#",
            "us-central1 ",
            "x-1",
        ] {
            assert_eq!(check_location(bad), Err(InvalidSetting::Region), "{bad:?}");
        }
    }

    #[test]
    fn checks_projects() {
        for ok in ["acme-test", "acme01", "a2345-7890-2345-7890-2345-7890"] {
            assert_eq!(check_project(ok), Ok(()), "{ok}");
        }
        for bad in [
            "",
            "acme",
            "1acme-test",
            "acme-test-",
            "Acme-test",
            "acme_test",
            "acme/test",
            "acme-test/../x",
            "a2345-7890-2345-7890-2345-78901",
        ] {
            assert_eq!(check_project(bad), Err(InvalidSetting::Project), "{bad:?}");
        }
    }

    #[test]
    fn checks_models() {
        for ok in [
            "gemini-2.5-flash",
            "gemini-2.5-flash-lite",
            "gemini_test.v2",
        ] {
            assert_eq!(check_model(ok), Ok(()), "{ok}");
        }
        for bad in [
            "",
            "gemini 2.5",
            "gemini/x",
            "gemini:x",
            "gemini?x",
            "gemini#x",
        ] {
            assert_eq!(check_model(bad), Err(InvalidSetting::Model), "{bad:?}");
        }
    }

    #[test]
    fn invalid_settings_carry_their_codes() {
        assert_eq!(InvalidSetting::Region.code(), "invalid_region");
        assert_eq!(InvalidSetting::Project.code(), "invalid_project");
        assert_eq!(InvalidSetting::Model.code(), "invalid_model");
    }

    #[test]
    fn builds_the_regional_and_global_addresses() {
        let account = || ServiceAccount {
            client_email: "tester@acme-test.iam.gserviceaccount.com".into(),
            private_key: String::new(),
            project_id: None,
        };
        let client = GeminiClient::new(
            account(),
            config("europe-west1", "acme-test", "gemini-2.5-flash"),
        )
        .unwrap();
        assert_eq!(
            client.generate_url().unwrap().as_str(),
            "https://europe-west1-aiplatform.googleapis.com/v1beta1/projects/acme-test/locations/europe-west1/publishers/google/models/gemini-2.5-flash:generateContent"
        );

        let client =
            GeminiClient::new(account(), config("global", "acme-test", "gemini-2.5-flash"))
                .unwrap();
        assert_eq!(
            client.generate_url().unwrap().as_str(),
            "https://aiplatform.googleapis.com/v1beta1/projects/acme-test/locations/global/publishers/google/models/gemini-2.5-flash:generateContent"
        );
    }

    #[test]
    fn refuses_settings_that_would_change_the_address() {
        let account = ServiceAccount {
            client_email: "tester@acme-test.iam.gserviceaccount.com".into(),
            private_key: String::new(),
            project_id: None,
        };
        let cases = [
            (
                config("evil.com#", "acme-test", "gemini-2.5-flash"),
                InvalidSetting::Region,
            ),
            (
                config("europe-west1", "acme/../x", "gemini-2.5-flash"),
                InvalidSetting::Project,
            ),
            (
                config("europe-west1", "acme-test", "m?x=1"),
                InvalidSetting::Model,
            ),
        ];
        for (config, expected) in cases {
            let error = GeminiClient::new(account.clone(), config).err();
            assert_eq!(error, Some(GeminiError::Setting(expected)));
        }
    }

    #[test]
    fn only_google_hosts_count_as_the_api() {
        let is_api = |url: &str| is_api_host(&Url::parse(url).unwrap());
        assert!(is_api("https://aiplatform.googleapis.com/v1"));
        assert!(is_api("https://europe-west1-aiplatform.googleapis.com/"));
        assert!(!is_api("http://europe-west1-aiplatform.googleapis.com/"));
        assert!(!is_api("https://aiplatform.googleapis.com.evil.com/"));
        assert!(!is_api("https://evilaiplatform.googleapis.com/"));
        assert!(!is_api("https://evil.com-aiplatform.googleapis.com/"));
        assert!(!is_api("https://x.europe-west1-aiplatform.googleapis.com/"));
    }

    #[test]
    fn asks_for_json_in_the_receipt_shape() {
        let text = body("P", &Payload::Text("ACME 10,00".into()), "gemini-2.5-flash");
        let config = &text["generationConfig"];
        assert_eq!(config["responseMimeType"], "application/json");
        assert_eq!(config["responseSchema"]["type"], "object");
        assert_eq!(config["responseSchema"]["required"], json!(["amount"]));
        for field in ["amount", "currency", "vendor", "date", "error"] {
            assert_eq!(
                config["responseSchema"]["properties"][field]["nullable"], true,
                "{field}"
            );
        }
        assert_eq!(
            config["responseSchema"]["properties"]["amount"]["type"],
            "number"
        );
    }

    #[test]
    fn turns_thinking_off_only_for_flash_models() {
        let payload = Payload::Text("ACME 10,00".into());
        for model in ["gemini-2.5-flash", "gemini-2.5-flash-lite"] {
            let body = body("P", &payload, model);
            assert_eq!(
                body["generationConfig"]["thinkingConfig"],
                json!({ "thinkingBudget": 0 }),
                "{model}"
            );
        }
        for model in ["gemini-2.5-pro", "gemini-test"] {
            let body = body("P", &payload, model);
            assert!(
                body["generationConfig"].get("thinkingConfig").is_none(),
                "{model}"
            );
        }
    }

    #[test]
    fn builds_text_and_image_requests() {
        let text = body("P", &Payload::Text("ACME 10,00".into()), "gemini-test");
        assert_eq!(
            text["contents"][0]["parts"][0]["text"],
            "P\n\nReceipt text:\nACME 10,00"
        );
        assert_eq!(text["generationConfig"]["maxOutputTokens"], 1024);

        let image = body(
            "P",
            &Payload::Image {
                base64: "AAAA".into(),
                mime_type: "image/png",
            },
            "gemini-test",
        );
        assert_eq!(image["contents"][0]["role"], "user");
        assert_eq!(image["contents"][0]["parts"][0]["text"], "P");
        assert_eq!(
            image["contents"][0]["parts"][1]["inline_data"]["mime_type"],
            "image/png"
        );
        assert_eq!(
            image["contents"][0]["parts"][1]["inline_data"]["data"],
            "AAAA"
        );
    }
}
