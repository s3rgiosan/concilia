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
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;

use crate::filecheck::{self, FileCheckError, FileKind};
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
    /// Gemini answered with an HTTP error that retries did not clear, such as a rate limit or
    /// an unknown model. Every receipt would fail the same way, so the run stops.
    #[error("{0}")]
    Service(String),
    /// This attempt failed; another attempt may work.
    #[error("{0}")]
    Failed(String),
    /// The file itself is refused, such as one too large or not a receipt type; another
    /// attempt would fail the same way.
    #[error("{message}")]
    Rejected { code: &'static str, message: String },
}

impl From<FileCheckError> for ExtractError {
    fn from(error: FileCheckError) -> ExtractError {
        match error.code() {
            Some(code) => ExtractError::Rejected {
                code,
                message: error.to_string(),
            },
            None => ExtractError::Failed(error.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ExtractAllError {
    #[error("{0}")]
    Fatal(String),
    #[error("{0}")]
    Service(String),
    #[error("cancelled")]
    Cancelled,
}

/// What an extractor read from a file before asking about it, reused by every attempt.
#[derive(Default)]
pub struct Prepared {
    payload: Option<Payload>,
    /// The first page as an image, rendered once when the text is not enough.
    image: OnceCell<Option<Payload>>,
}

#[async_trait]
pub trait ReceiptExtractor: Send + Sync {
    /// Reads the file once per receipt, before the attempts. Extractors without such a step
    /// prepare nothing.
    async fn prepare(&self, _file: &Path) -> Result<Prepared, ExtractError> {
        Ok(Prepared::default())
    }

    /// One attempt at reading a receipt with what `prepare` returned.
    async fn extract_prepared(
        &self,
        file: &Path,
        _prepared: &Prepared,
    ) -> Result<ReceiptMeta, ExtractError> {
        self.extract(file).await
    }

    /// Reads a receipt from scratch.
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
        refused: None,
        identity: None,
        extra: Default::default(),
    }
}

fn base64_image(bytes: &[u8], kind: FileKind) -> Payload {
    Payload::Image {
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        mime_type: kind.mime_type(),
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
            Ok(png) => Some(base64_image(&png, FileKind::Png)),
            Err(error) => {
                log::warn!("pdf render failed for {}: {error}", file.display());
                None
            }
        }
    }

    /// The payload for a file whose signature matches its extension: the image itself, or
    /// the PDF's text, or an image of its first page when the text is not usable.
    async fn payload(&self, file: &Path) -> Result<Option<Payload>, ExtractError> {
        let kind = filecheck::inspect(file).await?;
        let expects_pdf = is_pdf(file);
        if expects_pdf != (kind == FileKind::Pdf) {
            return Err(FileCheckError::Unrecognized(file.display().to_string()).into());
        }
        if kind.is_image() {
            let bytes = filecheck::read_capped(file).await?;
            return Ok(Some(base64_image(&bytes, kind)));
        }
        let text = match self.poppler.text(file).await {
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

    /// Runs Gemini, stopping on authorization failures and HTTP errors and treating other failures
    /// as no result.
    async fn ask(&self, file: &Path, payload: &Payload) -> Result<Option<Extracted>, ExtractError> {
        match self.client.extract(payload).await {
            Ok(result) => Ok(result),
            Err(GeminiError::Auth(message)) => Err(ExtractError::Fatal(message)),
            Err(error @ GeminiError::Http { .. }) => Err(ExtractError::Service(error.to_string())),
            Err(GeminiError::Setting(setting)) => Err(ExtractError::Fatal(setting.to_string())),
            Err(error) => {
                log::warn!("gemini failed for {}: {error}", file.display());
                Ok(None)
            }
        }
    }
}

#[async_trait]
impl ReceiptExtractor for GeminiExtractor {
    async fn prepare(&self, file: &Path) -> Result<Prepared, ExtractError> {
        Ok(Prepared {
            payload: self.payload(file).await?,
            image: OnceCell::new(),
        })
    }

    async fn extract_prepared(
        &self,
        file: &Path,
        prepared: &Prepared,
    ) -> Result<ReceiptMeta, ExtractError> {
        let name = file.to_string_lossy();
        let Some(payload) = &prepared.payload else {
            return Ok(unread(&name, "gemini"));
        };
        let mut result = self.ask(file, payload).await?;
        // A PDF whose text Gemini could not read gets a second chance as an image.
        if result.is_none() && matches!(payload, Payload::Text(_)) {
            let image = prepared.image.get_or_init(|| self.render(file)).await;
            if let Some(image) = image {
                result = self.ask(file, image).await?;
            }
        }
        Ok(match result {
            Some(extracted) => found(&name, extracted),
            None => unread(&name, "gemini"),
        })
    }

    async fn extract(&self, file: &Path) -> Result<ReceiptMeta, ExtractError> {
        let prepared = self.prepare(file).await?;
        self.extract_prepared(file, &prepared).await
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

/// One attempt: prepares the file unless an earlier attempt did, then reads it. Returns what
/// was prepared, for the next attempt, with the outcome.
async fn attempt(
    file: &Path,
    extractor: &dyn ReceiptExtractor,
    prepared: Option<Prepared>,
) -> Result<(Prepared, Result<ReceiptMeta, ExtractError>), ExtractError> {
    let prepared = match prepared {
        Some(prepared) => prepared,
        None => extractor.prepare(file).await?,
    };
    let outcome = extractor.extract_prepared(file, &prepared).await;
    Ok((prepared, outcome))
}

async fn extract_one(
    file: &str,
    extractor: &dyn ReceiptExtractor,
    options: &ExtractOptions,
    cancel: &CancellationToken,
) -> Result<ReceiptMeta, ExtractAllError> {
    let mut result = None;
    let mut prepared = None;
    for (attempt_index, wait) in options.backoff.iter().enumerate() {
        let number = attempt_index + 1;
        if !wait.is_zero() {
            log::debug!("retry {attempt_index} after {wait:?}: {file}");
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(ExtractAllError::Cancelled),
                _ = tokio::time::sleep(*wait) => {}
            }
        }
        let timed = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(ExtractAllError::Cancelled),
            r = tokio::time::timeout(
                options.attempt_timeout,
                attempt(Path::new(file), extractor, prepared.take()),
            ) => r,
        };
        let outcome = match timed {
            Ok(Ok((ready, outcome))) => {
                prepared = Some(ready);
                outcome
            }
            Ok(Err(error)) => Err(error),
            Err(_) => {
                log::warn!("attempt {number} timed out for {file}");
                continue;
            }
        };
        match outcome {
            Ok(meta) => {
                let has_amount = meta.amount_cents.is_some();
                result = Some(meta);
                if has_amount {
                    break;
                }
                log::debug!("no amount on attempt {number}: {file}");
            }
            Err(ExtractError::Fatal(message)) => return Err(ExtractAllError::Fatal(message)),
            Err(ExtractError::Service(message)) => return Err(ExtractAllError::Service(message)),
            Err(ExtractError::Rejected { code, message }) => {
                log::warn!("not reading {file}: {message}");
                return Ok(ReceiptMeta::refused(file, code));
            }
            Err(ExtractError::Failed(message)) => {
                log::warn!("attempt {number} failed for {file}: {message}")
            }
        }
    }
    Ok(result.unwrap_or_else(|| unread(file, "error")))
}

/// How far an [`extract_all`] run is.
#[derive(Debug, Clone, Copy)]
pub struct ExtractProgress<'a> {
    /// Files done so far, cache hits included.
    pub done: usize,
    /// The receipt just read and its index in the file list; none for the cache hits, which
    /// are reported together before extraction starts.
    pub extracted: Option<(usize, &'a ReceiptMeta)>,
}

/// Extracts every file, in order. Entries of `cache` with `high` confidence are reused unless
/// `force` is set. `on_progress` receives the number of files done: once for all the cache
/// hits, then after each file read.
pub async fn extract_all(
    files: &[String],
    cache: &[ReceiptMeta],
    force: bool,
    extractor: &dyn ReceiptExtractor,
    options: &ExtractOptions,
    on_progress: &(dyn Fn(usize) + Send + Sync),
    cancel: &CancellationToken,
) -> Result<Vec<ReceiptMeta>, ExtractAllError> {
    let report = |progress: ExtractProgress<'_>| on_progress(progress.done);
    extract_all_observed(files, cache, force, extractor, options, &report, cancel).await
}

/// [`extract_all`], reporting each receipt read along with the count.
pub async fn extract_all_observed(
    files: &[String],
    cache: &[ReceiptMeta],
    force: bool,
    extractor: &dyn ReceiptExtractor,
    options: &ExtractOptions,
    on_progress: &(dyn for<'a> Fn(ExtractProgress<'a>) + Send + Sync),
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
    let mut results: Vec<Option<ReceiptMeta>> = files
        .iter()
        .map(|file| cached.get(file.as_str()).map(|meta| (*meta).clone()))
        .collect();
    let hits = results.iter().filter(|r| r.is_some()).count();
    if hits > 0 {
        on_progress(ExtractProgress {
            done: hits,
            extracted: None,
        });
    }
    let done = AtomicUsize::new(hits);
    // The futures are built up front: they start only when the stream polls them, and a
    // stream of closures would make the returned future not `Send`.
    let jobs: Vec<_> = files
        .iter()
        .enumerate()
        .filter(|(index, _)| results[*index].is_none())
        .map(|(index, file)| {
            let done = &done;
            async move {
                let meta = extract_one(file, extractor, options, cancel).await?;
                on_progress(ExtractProgress {
                    done: done.fetch_add(1, Ordering::SeqCst) + 1,
                    extracted: Some((index, &meta)),
                });
                Ok::<_, ExtractAllError>((index, meta))
            }
        })
        .collect();
    let work = stream::iter(jobs)
        .buffer_unordered(options.concurrency.max(1))
        .try_collect::<Vec<_>>();
    let extracted = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(ExtractAllError::Cancelled),
        result = work => result?,
    };
    for (index, meta) in extracted {
        results[index] = Some(meta);
    }
    Ok(results.into_iter().flatten().collect())
}
