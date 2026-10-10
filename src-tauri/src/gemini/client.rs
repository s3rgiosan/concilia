//! Gemini on Google's Gemini Enterprise Agent Platform, authenticated with a Google service
//! account.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::parse::{parse_json_from_text, Extracted};
use super::prompt::{RECEIPT_PROMPT, RETRY_PROMPT};

pub const DEFAULT_LOCATION: &str = "europe-west1";
pub const DEFAULT_MODEL: &str = "gemini-2.5-flash";
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
    api_base: String,
    token: Mutex<Option<(String, Instant)>>,
}

impl GeminiClient {
    pub fn new(account: ServiceAccount, config: GeminiConfig) -> Result<GeminiClient, GeminiError> {
        let api_base = format!("https://{}-aiplatform.googleapis.com", config.location);
        GeminiClient::with_endpoints(account, config, TOKEN_URL.into(), api_base)
    }

    /// A client that talks to other token and API servers, such as a test server.
    pub fn with_endpoints(
        account: ServiceAccount,
        config: GeminiConfig,
        token_url: String,
        api_base: String,
    ) -> Result<GeminiClient, GeminiError> {
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

    fn generate_url(&self) -> String {
        let GeminiConfig {
            project,
            location,
            model,
        } = &self.config;
        format!(
            "{}/v1beta1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent",
            self.api_base
        )
    }

    /// Sends one request. Returns the reply text, or none when the server answered with an
    /// error other than an authorization failure.
    async fn call(&self, prompt: &str, payload: &Payload) -> Result<Option<String>, GeminiError> {
        let token = self.access_token().await?;
        let response = self
            .http
            .post(self.generate_url())
            .timeout(GENERATE_TIMEOUT)
            .bearer_auth(token)
            .json(&request_body(prompt, payload))
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

/// The `generateContent` request body: the prompt, with the receipt text appended or the
/// image attached.
fn request_body(prompt: &str, payload: &Payload) -> Value {
    let parts = match payload {
        Payload::Text(text) => json!([{ "text": format!("{prompt}\n\nReceipt text:\n{text}") }]),
        Payload::Image { base64, mime_type } => json!([
            { "text": prompt },
            { "inline_data": { "mime_type": mime_type, "data": base64 } }
        ]),
    };
    json!({
        "contents": [{ "role": "user", "parts": parts }],
        "generationConfig": { "maxOutputTokens": 1024 }
    })
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

    #[test]
    fn builds_text_and_image_requests() {
        let text = request_body("P", &Payload::Text("ACME 10,00".into()));
        assert_eq!(
            text["contents"][0]["parts"][0]["text"],
            "P\n\nReceipt text:\nACME 10,00"
        );
        assert_eq!(text["generationConfig"]["maxOutputTokens"], 1024);

        let image = request_body(
            "P",
            &Payload::Image {
                base64: "AAAA".into(),
                mime_type: "image/png",
            },
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
