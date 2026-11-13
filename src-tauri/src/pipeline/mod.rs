//! The reconciliation jobs on one period's files: reconcile, scan, add statements, rescan,
//! Finalize, report export, review data, drafts and month folders. Callers hold the period's
//! locks; nothing here touches Tauri.

mod apply;
mod draft;
mod periods;
mod reopen;
mod report;
mod rescan;
mod run;

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::bank::Bank;
use crate::error::ErrorKind;
use crate::extract::{ExtractAllError, ExtractOptions, ReceiptExtractor};
use crate::filecheck::{self, FileCheckError, FileKind};
use crate::fsutil::{read_json_lenient, FsError};
use crate::model::{Language, Reason, ReceiptMeta, Rule};
use crate::period::PeriodPaths;
use crate::poppler::{Poppler, PopplerError};

pub use apply::finalize;
pub use draft::{delete_draft, read_draft, save_draft};
pub use periods::{
    ensure_period_dirs, list_periods, period_status, period_summary, read_statements, reset_period,
    PeriodState, PeriodStatus, PeriodSummary, ResetReport,
};
pub use reopen::{reopen, ReopenReport};
pub use report::{export_report, review_data, ReceiptView, ReviewData, ReviewTransaction};
pub use rescan::{rescan, resolve_period_file, PeriodFile, RescanKind};
pub use run::{
    add_statements, reconcile, scan_receipts, AddStatementsResult, ScanOutcome, StatementOutcome,
};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PipelineError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Parse(String),
    #[error("{0} not found; install poppler")]
    PopplerMissing(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("this period is finalized; re-run it to scan again")]
    Finalized,
    #[error("cancelled")]
    Cancelled,
    #[error("{0}")]
    Io(String),
    /// A known case the frontend words by `code`.
    #[error("{message}")]
    Coded {
        kind: ErrorKind,
        code: &'static str,
        message: String,
    },
}

impl PipelineError {
    pub fn coded(kind: ErrorKind, code: &'static str, message: impl Into<String>) -> Self {
        PipelineError::Coded {
            kind,
            code,
            message: message.into(),
        }
    }

    fn not_reconciled() -> Self {
        PipelineError::coded(
            ErrorKind::NotFound,
            "not_reconciled",
            "this period has not been reconciled yet",
        )
    }
}

impl From<FsError> for PipelineError {
    fn from(error: FsError) -> PipelineError {
        PipelineError::Io(error.to_string())
    }
}

impl From<ExtractAllError> for PipelineError {
    fn from(error: ExtractAllError) -> PipelineError {
        match error {
            ExtractAllError::Fatal(message) => PipelineError::Unauthorized(message),
            ExtractAllError::Cancelled => PipelineError::Cancelled,
        }
    }
}

impl From<PopplerError> for PipelineError {
    fn from(error: PopplerError) -> PipelineError {
        match error {
            PopplerError::Missing(tool) => PipelineError::PopplerMissing(tool),
            PopplerError::Failed(message) => PipelineError::Parse(message),
            PopplerError::TooLarge(_) => {
                PipelineError::coded(ErrorKind::Parse, "pdf_output_too_large", error.to_string())
            }
        }
    }
}

impl From<FileCheckError> for PipelineError {
    fn from(error: FileCheckError) -> PipelineError {
        match error.code() {
            Some(code) => PipelineError::coded(ErrorKind::InvalidInput, code, error.to_string()),
            None => PipelineError::Io(error.to_string()),
        }
    }
}

/// Runs file or CPU work on the blocking thread pool, keeping it off the async workers.
pub(crate) async fn off_thread<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, PipelineError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| PipelineError::Io(format!("background work failed: {e}")))
}

fn io(path: &Path, error: impl std::fmt::Display) -> PipelineError {
    PipelineError::Io(format!("{}: {error}", path.display()))
}

/// Progress of a reconcile or scan, in the order the steps run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "step", rename_all = "snake_case")]
pub enum RunEvent {
    Parsing { count: usize },
    ReceiptsFound { count: usize },
    Extracting { current: usize, total: usize },
    Matching,
    ReimbursementsFound { count: usize },
    ExtractingReimbursements { current: usize, total: usize },
    Exporting,
}

/// The text of a statement PDF.
#[async_trait]
pub trait StatementText: Send + Sync {
    async fn text(&self, pdf: &Path) -> Result<String, PipelineError>;
}

#[async_trait]
impl StatementText for Poppler {
    async fn text(&self, pdf: &Path) -> Result<String, PipelineError> {
        Ok(Poppler::text(self, pdf).await?)
    }
}

/// Checks that a statement is a PDF of at most 50 MB, by its first bytes.
async fn check_statement(pdf: &Path) -> Result<(), PipelineError> {
    match filecheck::inspect(pdf).await {
        Ok(FileKind::Pdf) => Ok(()),
        Ok(_) | Err(FileCheckError::Unrecognized(_)) => Err(not_pdf(pdf)),
        Err(error) => Err(error.into()),
    }
}

fn not_pdf(pdf: &Path) -> PipelineError {
    PipelineError::coded(
        ErrorKind::InvalidInput,
        "not_pdf",
        format!("{} is not a PDF file", pdf.display()),
    )
}

/// Everything a reconcile or scan needs besides the period's files.
pub struct RunContext<'a> {
    pub paths: PeriodPaths,
    pub extractor: &'a dyn ReceiptExtractor,
    pub statements: &'a dyn StatementText,
    pub rules: Vec<Rule>,
    pub language: Language,
    /// Names the no-receipt reasons in the report.
    pub reasons: Vec<Reason>,
    pub options: ExtractOptions,
    pub progress: &'a (dyn Fn(RunEvent) + Send + Sync),
    pub cancel: CancellationToken,
}

impl RunContext<'_> {
    fn check_cancelled(&self) -> Result<(), PipelineError> {
        if self.cancel.is_cancelled() {
            Err(PipelineError::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// A statement to parse: its PDF and the bank that issued it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatementFile {
    pub path: PathBuf,
    pub bank: Bank,
}

fn create_dir(dir: &Path) -> Result<(), PipelineError> {
    std::fs::create_dir_all(dir).map_err(|e| io(dir, e))
}

/// Reads a cache file, treating an unreadable one as empty so extraction starts over.
fn read_cache(path: &Path) -> Vec<ReceiptMeta> {
    read_json_lenient(path).unwrap_or_default()
}

/// The receipts that were read or tried, without those refused before reading.
fn readable(receipts: Vec<ReceiptMeta>) -> Vec<ReceiptMeta> {
    receipts.into_iter().filter(|r| !r.is_refused()).collect()
}

/// The cached reimbursements that were read or tried.
fn read_reimbursements(paths: &PeriodPaths) -> Vec<ReceiptMeta> {
    readable(read_cache(&paths.reimbursements_cache()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_run_events_with_a_step_tag() {
        let event = serde_json::to_value(RunEvent::Extracting {
            current: 1,
            total: 3,
        })
        .unwrap();
        assert_eq!(
            event,
            serde_json::json!({ "step": "extracting", "current": 1, "total": 3 })
        );
        let event = serde_json::to_value(RunEvent::Matching).unwrap();
        assert_eq!(event, serde_json::json!({ "step": "matching" }));
    }
}
