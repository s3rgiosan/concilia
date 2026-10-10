//! The pending review draft: reading and writing it, and keeping it in step with a new match.

use std::collections::{HashMap, HashSet};

use super::{create_dir, io, PipelineError};
use crate::fsutil::{read_json_lenient, read_json_opt, remove_if_exists, write_json};
use crate::matcher::match_transactions;
use crate::model::{Draft, DroppedDecision, MatchResult, ReceiptMeta, Rule, StatementTransaction};
use crate::period::PeriodPaths;
use crate::review::{claimed_files, clean_draft, merge_draft};

pub fn read_draft(paths: &PeriodPaths) -> Result<Draft, PipelineError> {
    Ok(read_json_opt(&paths.draft())?.unwrap_or_default())
}

pub fn save_draft(paths: &PeriodPaths, draft: &Draft) -> Result<(), PipelineError> {
    create_dir(&paths.docs)?;
    Ok(write_json(&paths.draft(), draft)?)
}

pub fn delete_draft(paths: &PeriodPaths) -> Result<(), PipelineError> {
    let draft = paths.draft();
    remove_if_exists(&draft).map_err(|e| io(&draft, e))
}

/// Matches the transactions again without handing a receipt claimed by a draft decision to
/// any transaction. Claimed receipts stay out of the automatic pool and are listed among the
/// unmatched receipts unless their own transaction's previous entry lists them, so they return
/// to the review pool when the decision is undone.
pub(super) fn match_keeping_draft(
    paths: &PeriodPaths,
    transactions: &[StatementTransaction],
    receipts: &[ReceiptMeta],
    rules: &[Rule],
) -> MatchResult {
    let previous: Option<MatchResult> = read_json_lenient(&paths.match_result());
    let draft: Draft = read_json_lenient(&paths.draft()).unwrap_or_default();
    let (Some(previous), false) = (previous, draft.is_empty()) else {
        return match_transactions(transactions, receipts, rules);
    };
    let present: HashSet<&str> = receipts.iter().map(|r| r.file.as_str()).collect();
    let claims: HashMap<String, String> = draft_claims(&previous, &draft)
        .into_iter()
        .filter(|(file, _)| present.contains(file.as_str()))
        .collect();
    if claims.is_empty() {
        return match_transactions(transactions, receipts, rules);
    }

    let pool: Vec<ReceiptMeta> = receipts
        .iter()
        .filter(|r| !claims.contains_key(&r.file))
        .cloned()
        .collect();
    let mut result = match_transactions(transactions, &pool, rules);

    // The transactions holding a claim keep the entry the user decided on, less receipts that
    // are gone.
    let owners: HashSet<&str> = claims.values().map(String::as_str).collect();
    for tx in &mut result.transactions {
        if !owners.contains(tx.id.as_str()) {
            continue;
        }
        if let Some(before) = previous.transactions.iter().find(|p| p.id == tx.id) {
            let mut kept = before.clone();
            kept.receipt_meta
                .retain(|m| present.contains(m.file.as_str()));
            kept.receipt_files.retain(|f| present.contains(f.as_str()));
            *tx = kept;
        }
    }

    let referenced: HashSet<String> = result
        .transactions
        .iter()
        .flat_map(|tx| tx.receipt_meta.iter().map(|m| m.file.clone()))
        .collect();
    for receipt in receipts {
        let unreferenced_claim =
            claims.contains_key(&receipt.file) && !referenced.contains(&receipt.file);
        if unreferenced_claim {
            result.unmatched_receipts.push(receipt.clone());
            result
                .receipts_by_status
                .unmatched
                .push(receipt.file.clone());
        }
    }
    result
}

/// Rewrites the saved review draft without the decisions whose receipts are gone, and returns
/// those decisions. A draft that cannot be read or written is left as it is.
pub(super) fn clean_saved_draft(
    paths: &PeriodPaths,
    receipts: &[ReceiptMeta],
    result: &MatchResult,
) -> Vec<DroppedDecision> {
    match read_json_opt::<Draft>(&paths.draft()) {
        Ok(Some(draft)) => {
            let present: HashSet<String> = receipts.iter().map(|r| r.file.clone()).collect();
            let (kept, removed) = clean_draft(&draft, &present, &result.transactions);
            if let Err(error) = write_json(&paths.draft(), &kept) {
                log::warn!("could not update the review draft: {error}");
                Vec::new()
            } else {
                removed
            }
        }
        Ok(None) => Vec::new(),
        Err(error) => {
            log::warn!("could not read the review draft: {error}");
            Vec::new()
        }
    }
}

/// Receipt files that saved draft decisions bind to their transactions, with the ID of the
/// transaction each one belongs to. A decision claims the receipts of a transaction it leaves
/// MATCHED, unless it marks the transaction as needing no receipt, as `claimed_files` counts
/// them for the review pool.
fn draft_claims(previous: &MatchResult, draft: &Draft) -> HashMap<String, String> {
    let merged = match merge_draft(previous, draft) {
        Ok(merged) => merged,
        Err(error) => {
            log::warn!("matching without the review draft: {error}");
            return HashMap::new();
        }
    };
    merged
        .into_iter()
        .filter(|tx| draft.contains_key(&tx.id))
        .flat_map(|tx| {
            let files = claimed_files(std::slice::from_ref(&tx));
            files.into_iter().map(move |file| (file, tx.id.clone()))
        })
        .collect()
}
