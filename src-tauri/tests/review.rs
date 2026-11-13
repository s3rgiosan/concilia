//! Review cases shared with the frontend's tests (`src/review/effective.shared.test.ts`), so
//! the pool the review screen shows and the one Finalize sorts stay the same.

use std::collections::BTreeMap;
use std::path::PathBuf;

use concilia_lib::model::{Draft, MatchResult, Status};
use concilia_lib::review::{effective_unmatched, merge_draft};
use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    name: String,
    draft: Draft,
    statuses: BTreeMap<String, Status>,
    pool: Vec<String>,
}

#[derive(Deserialize)]
struct Fixture {
    result: MatchResult,
    cases: Vec<Case>,
}

#[test]
fn review_cases_match_the_frontend() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/review/cases.json");
    let fixture: Fixture = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert!(!fixture.cases.is_empty());
    for case in &fixture.cases {
        let merged = merge_draft(&fixture.result, &case.draft).unwrap();
        for (id, status) in &case.statuses {
            let tx = merged.iter().find(|t| &t.id == id).unwrap();
            assert_eq!(&tx.status, status, "{}: {id}", case.name);
        }
        let pool: Vec<String> = effective_unmatched(&fixture.result, &merged)
            .into_iter()
            .map(|r| r.file)
            .collect();
        assert_eq!(pool, case.pool, "{}", case.name);
    }
}
