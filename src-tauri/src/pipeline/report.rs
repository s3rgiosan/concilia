//! The Excel report and the data the review screen loads.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use super::periods::read_statements;
use super::stored::{read_stored, read_stored_lenient};
use super::{io, read_cache, read_reimbursements, PipelineError};
use crate::excel;
use crate::finalize::TRANSIENT_FIELDS;
use crate::model::{
    Draft, Language, MatchResult, Reason, ReceiptMeta, StatementRecord, Status, Transaction,
};
use crate::period::PeriodPaths;
use crate::review::merge_draft;

/// Writes the report through a temporary file next to `path`.
pub(super) fn write_report(
    result: &MatchResult,
    reimbursements: &[ReceiptMeta],
    language: Language,
    reasons: &[Reason],
    path: &Path,
) -> Result<(), PipelineError> {
    let labels = excel::Labels { language, reasons };
    let sheets = excel::build(result, reimbursements, &labels);
    let tmp = path.with_extension("xlsx.tmp");
    excel::write(&sheets, &tmp).map_err(|e| io(&tmp, e))?;
    std::fs::rename(&tmp, path).map_err(|e| io(path, e))
}

/// A receipt as the review screen shows it: its stored fields plus the period-relative path
/// the preview loads, null for a file outside the period.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReceiptView {
    #[serde(flatten)]
    pub meta: ReceiptMeta,
    pub rel_path: Option<String>,
}

impl ReceiptView {
    /// The view of a stored receipt. Display fields a stored file may still carry are dropped,
    /// so each key appears once.
    pub fn new(paths: &PeriodPaths, mut meta: ReceiptMeta) -> ReceiptView {
        let rel_path = paths.relative(&meta.file);
        for field in TRANSIENT_FIELDS {
            meta.extra.remove(*field);
        }
        ReceiptView { meta, rel_path }
    }
}

/// A transaction with its receipts as the review screen shows them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReviewTransaction {
    pub id: String,
    pub date: String,
    pub description: String,
    pub amount_cents: i64,
    pub abs_cents: i64,
    pub status: Status,
    pub receipt_files: Vec<String>,
    pub receipt_meta: Vec<ReceiptView>,
    pub notes: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A file in the receipts or reimbursements folder that Concilia refused to read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RefusedFile {
    pub file: String,
    pub rel_path: Option<String>,
    /// Why it was refused, such as `file_too_large`.
    pub code: String,
}

/// What the review screen loads.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReviewData {
    pub transactions: Vec<ReviewTransaction>,
    pub unmatched_receipts: Vec<ReceiptView>,
    pub reimbursements: Vec<ReceiptView>,
    pub statements: Vec<StatementRecord>,
    pub refused_files: Vec<RefusedFile>,
}

/// Writes the report from the match result with pending review decisions applied, and
/// returns its path. Decisions that cannot be applied are left out.
pub fn export_report(
    paths: &PeriodPaths,
    language: Language,
    reasons: &[Reason],
) -> Result<PathBuf, PipelineError> {
    super::journal::recover(paths)?;
    let result: MatchResult = read_stored(&paths.dir, &paths.match_result())?
        .ok_or_else(PipelineError::not_reconciled)?;
    let draft: Draft = read_stored_lenient(&paths.dir, &paths.draft()).unwrap_or_default();
    let shown = match merge_draft(&result, &draft) {
        Ok(transactions) => MatchResult {
            transactions,
            receipts_by_status: result.receipts_by_status,
            unmatched_receipts: result.unmatched_receipts,
            original_paths: result.original_paths,
        },
        Err(error) => {
            log::warn!("report without the review draft: {error}");
            result
        }
    };
    let reimbursements = read_reimbursements(paths);
    write_report(&shown, &reimbursements, language, reasons, &paths.report())?;
    Ok(paths.report())
}

/// The match result and reimbursements, each receipt with its period-relative `rel_path` for
/// previews, and the statements the period holds.
pub fn review_data(paths: &PeriodPaths) -> Result<ReviewData, PipelineError> {
    let result: MatchResult = read_stored(&paths.dir, &paths.match_result())?
        .ok_or_else(PipelineError::not_reconciled)?;
    let view = |meta| ReceiptView::new(paths, meta);
    let transactions = result
        .transactions
        .into_iter()
        .map(|tx| review_transaction(tx, &view))
        .collect();
    Ok(ReviewData {
        transactions,
        unmatched_receipts: result.unmatched_receipts.into_iter().map(&view).collect(),
        reimbursements: read_reimbursements(paths).into_iter().map(&view).collect(),
        statements: read_statements(paths),
        refused_files: refused_files(paths),
    })
}

/// The files the last extraction refused that are still in the period, receipts first. A file
/// the user has since removed is left out.
fn refused_files(paths: &PeriodPaths) -> Vec<RefusedFile> {
    [paths.receipts_cache(), paths.reimbursements_cache()]
        .iter()
        .flat_map(|cache| read_cache(&paths.dir, cache))
        .filter_map(|meta| {
            let code = meta.refused.clone()?;
            let exists = Path::new(&meta.file).is_file();
            exists.then(|| RefusedFile {
                rel_path: paths.relative(&meta.file),
                file: meta.file,
                code,
            })
        })
        .collect()
}

fn review_transaction(
    tx: Transaction,
    view: &impl Fn(ReceiptMeta) -> ReceiptView,
) -> ReviewTransaction {
    ReviewTransaction {
        id: tx.id,
        date: tx.date,
        description: tx.description,
        amount_cents: tx.amount_cents,
        abs_cents: tx.abs_cents,
        status: tx.status,
        receipt_files: tx.receipt_files,
        receipt_meta: tx.receipt_meta.into_iter().map(view).collect(),
        notes: tx.notes,
        extra: tx.extra,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::period::Period;

    #[test]
    fn serializes_each_receipt_field_once() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Period::parse("2030", "03").unwrap().paths(dir.path());
        let file = paths
            .receipts
            .join("acme.pdf")
            .to_string_lossy()
            .into_owned();
        let mut meta = ReceiptMeta {
            file,
            amount_cents: Some(1000),
            ..Default::default()
        };
        meta.extra
            .insert("rel_path".into(), Value::String("stale".into()));
        meta.extra
            .insert("note".into(), Value::String("kept".into()));
        let json = serde_json::to_string(&ReceiptView::new(&paths, meta)).unwrap();
        assert_eq!(json.matches("\"rel_path\"").count(), 1, "{json}");
        assert!(
            json.contains("\"rel_path\":\"2030/03/receipts/acme.pdf\""),
            "{json}"
        );
        assert!(json.contains("\"note\":\"kept\""), "{json}");
    }
}
