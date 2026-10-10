//! Extracting receipt metadata: one receipt through Gemini, and a whole folder with a cache,
//! retries and a bounded number of receipts in flight.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use futures::stream::{self, StreamExt, TryStreamExt};
use tokio_util::sync::CancellationToken;

use crate::gemini::client::{GeminiClient, GeminiError, Payload};
use crate::gemini::parse::Extracted;
use crate::model::ReceiptMeta;
use crate::poppler::Poppler;
use crate::receipts::{is_pdf, is_usable_pdf_text};

/// Resolution of the page image sent when a PDF has no usable text.
const RENDER_DPI: u32 = 300;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ExtractError {
    /// Every receipt would fail the same way, so the run stops.
    #[error("{0}")]
    Fatal(String),
    /// This attempt failed; another attempt may work.
    #[error("{0}")]
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ExtractAllError {
    #[error("{0}")]
    Fatal(String),
    #[error("cancelled")]
    Cancelled,
}

#[async_trait]
pub trait ReceiptExtractor: Send + Sync {
    async fn extract(&self, file: &Path) -> Result<ReceiptMeta, ExtractError>;
}

/// Metadata for a receipt Gemini could not read.
pub fn unread(file: &str, provider: &str) -> ReceiptMeta {
    ReceiptMeta {
        file: file.to_string(),
        provider_used: Some(provider.to_string()),
        ..Default::default()
    }
}

fn found(file: &str, extracted: Extracted) -> ReceiptMeta {
    ReceiptMeta {
        file: file.to_string(),
        amount_cents: Some(extracted.amount_cents),
        confidence: Some("high".into()),
        currency: extracted.currency,
        vendor: extracted.vendor,
        date: extracted.date,
        provider_used: Some("gemini".into()),
        extra: Default::default(),
    }
}

fn image_mime(file: &Path) -> &'static str {
    let extension = file
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match extension.as_deref() {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        _ => "image/png",
    }
}

/// Reads receipts with Gemini: a PDF's text when it is usable, otherwise an image of its first
/// page; image files as they are.
pub struct GeminiExtractor {
    pub client: Arc<GeminiClient>,
    pub poppler: Poppler,
}

impl GeminiExtractor {
    async fn render(&self, file: &Path) -> Option<Payload> {
        match self.poppler.render_page(file, 1, RENDER_DPI).await {
            Ok(png) => Some(Payload::Image {
                base64: base64::engine::general_purpose::STANDARD.encode(png),
                mime_type: "image/png",
            }),
            Err(error) => {
                log::warn!("pdf render failed for {}: {error}", file.display());
                None
            }
        }
    }

    async fn payload(&self, file: &Path) -> Result<Option<Payload>, ExtractError> {
        let bytes = tokio::fs::read(file)
            .await
            .map_err(|e| ExtractError::Failed(format!("{}: {e}", file.display())))?;
        if !is_pdf(file) {
            return Ok(Some(Payload::Image {
                base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                mime_type: image_mime(file),
            }));
        }
        let text = match self.poppler.text(&bytes).await {
            Ok(text) => text,
            Err(error) => {
                log::warn!("pdf text failed for {}: {error}", file.display());
                String::new()
            }
        };
        if is_usable_pdf_text(&text) {
            return Ok(Some(Payload::Text(text)));
        }
        Ok(self.render(file).await)
    }

    /// Runs Gemini, stopping on authorization failures and treating other failures as no result.
    async fn ask(&self, file: &Path, payload: &Payload) -> Result<Option<Extracted>, ExtractError> {
        match self.client.extract(payload).await {
            Ok(result) => Ok(result),
            Err(GeminiError::Auth(message)) => Err(ExtractError::Fatal(message)),
            Err(error) => {
                log::warn!("gemini failed for {}: {error}", file.display());
                Ok(None)
            }
        }
    }
}

#[async_trait]
impl ReceiptExtractor for GeminiExtractor {
    async fn extract(&self, file: &Path) -> Result<ReceiptMeta, ExtractError> {
        let name = file.to_string_lossy();
        let Some(payload) = self.payload(file).await? else {
            return Ok(unread(&name, "gemini"));
        };
        let mut result = self.ask(file, &payload).await?;
        // A PDF whose text Gemini could not read gets a second chance as an image.
        if result.is_none() && matches!(payload, Payload::Text(_)) {
            if let Some(image) = self.render(file).await {
                result = self.ask(file, &image).await?;
            }
        }
        Ok(match result {
            Some(extracted) => found(&name, extracted),
            None => unread(&name, "gemini"),
        })
    }
}

/// Retry and concurrency settings for [`extract_all`].
#[derive(Debug, Clone)]
pub struct ExtractOptions {
    /// Wait before each attempt; its length is the number of attempts.
    pub backoff: Vec<Duration>,
    pub attempt_timeout: Duration,
    pub concurrency: usize,
}

impl Default for ExtractOptions {
    fn default() -> ExtractOptions {
        ExtractOptions {
            backoff: vec![
                Duration::ZERO,
                Duration::from_millis(1500),
                Duration::from_millis(4000),
            ],
            attempt_timeout: Duration::from_secs(180),
            concurrency: 4,
        }
    }
}

async fn extract_one(
    file: &str,
    extractor: &dyn ReceiptExtractor,
    options: &ExtractOptions,
    cancel: &CancellationToken,
) -> Result<ReceiptMeta, ExtractAllError> {
    let mut result = None;
    for (attempt, wait) in options.backoff.iter().enumerate() {
        if !wait.is_zero() {
            log::debug!("retry {attempt} after {wait:?}: {file}");
            tokio::select! {
            biased;
                    _ = cancel.cancelled() => return Err(ExtractAllError::Cancelled),
                    _ = tokio::time::sleep(*wait) => {}
                }
        }
        let attempt_result = tokio::select! {
        biased;
            _ = cancel.cancelled() => return Err(ExtractAllError::Cancelled),
            r = tokio::time::timeout(options.attempt_timeout, extractor.extract(Path::new(file))) => r,
        };
        match attempt_result {
            Ok(Ok(meta)) => {
                let has_amount = meta.amount_cents.is_some();
                result = Some(meta);
                if has_amount {
                    break;
                }
                log::debug!("no amount on attempt {}: {file}", attempt + 1);
            }
            Ok(Err(ExtractError::Fatal(message))) => return Err(ExtractAllError::Fatal(message)),
            Ok(Err(ExtractError::Failed(message))) => {
                log::warn!("attempt {} failed for {file}: {message}", attempt + 1)
            }
            Err(_) => log::warn!("attempt {} timed out for {file}", attempt + 1),
        }
    }
    Ok(result.unwrap_or_else(|| unread(file, "error")))
}

/// Extracts every file, in order. Entries of `cache` with `high` confidence are reused unless
/// `force` is set. `on_progress` receives the number of files done after each one.
pub async fn extract_all(
    files: &[String],
    cache: &[ReceiptMeta],
    force: bool,
    extractor: &dyn ReceiptExtractor,
    options: &ExtractOptions,
    on_progress: &(dyn Fn(usize) + Send + Sync),
    cancel: &CancellationToken,
) -> Result<Vec<ReceiptMeta>, ExtractAllError> {
    let cached: HashMap<&str, &ReceiptMeta> = if force {
        HashMap::new()
    } else {
        cache
            .iter()
            .filter(|r| !r.file.is_empty() && r.confidence.as_deref() == Some("high"))
            .map(|r| (r.file.as_str(), r))
            .collect()
    };
    let done = AtomicUsize::new(0);
    // The futures are built up front: they start only when the stream polls them, and a
    // stream of closures would make the returned future not `Send`.
    let jobs: Vec<_> = files
        .iter()
        .map(|file| {
            let cached = cached.get(file.as_str()).copied().cloned();
            let done = &done;
            async move {
                let meta = match cached {
                    Some(meta) => meta,
                    None => extract_one(file, extractor, options, cancel).await?,
                };
                on_progress(done.fetch_add(1, Ordering::SeqCst) + 1);
                Ok::<_, ExtractAllError>(meta)
            }
        })
        .collect();
    let work = stream::iter(jobs)
        .buffered(options.concurrency.max(1))
        .try_collect::<Vec<_>>();
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(ExtractAllError::Cancelled),
        result = work => result,
    }
}
