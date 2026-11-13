//! The receipt extraction pool: ordering, concurrency, cache, retries, timeouts, fatal errors,
//! cancellation and progress.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use concilia_lib::extract::{
    extract_all, unread, ExtractAllError, ExtractError, ExtractOptions, Prepared, ReceiptExtractor,
};
use concilia_lib::model::ReceiptMeta;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

/// What the fake extractor does on one attempt.
#[derive(Debug, Clone)]
enum Step {
    /// Reads the receipt with this amount.
    Found(i64),
    /// Answers without an amount.
    Empty,
    Fail,
    Fatal,
    /// Never answers.
    Hang,
}

/// Decrements the in-flight counter when an attempt ends, including when it is dropped.
struct InFlight<'a>(&'a AtomicUsize);

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A scripted extractor. Each file follows its list of steps, one per attempt, repeating the
/// last step; files without a script read as `Found(1000)`.
#[derive(Default)]
struct Fake {
    steps: HashMap<String, Vec<Step>>,
    delays: HashMap<String, Duration>,
    calls: Mutex<Vec<(String, Instant)>>,
    finished: Mutex<Vec<String>>,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
}

impl Fake {
    fn new() -> Fake {
        Fake::default()
    }

    fn script(mut self, file: &str, steps: &[Step]) -> Fake {
        self.steps.insert(file.to_string(), steps.to_vec());
        self
    }

    fn delay(mut self, file: &str, delay: Duration) -> Fake {
        self.delays.insert(file.to_string(), delay);
        self
    }

    fn calls_for(&self, file: &str) -> Vec<Instant> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(f, _)| f == file)
            .map(|(_, at)| *at)
            .collect()
    }

    fn total_calls(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

#[async_trait]
impl ReceiptExtractor for Fake {
    async fn extract(&self, file: &Path) -> Result<ReceiptMeta, ExtractError> {
        let name = file.to_string_lossy().into_owned();
        let attempt = {
            let mut calls = self.calls.lock().unwrap();
            calls.push((name.clone(), Instant::now()));
            calls.iter().filter(|(f, _)| *f == name).count()
        };
        let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_in_flight.fetch_max(now, Ordering::SeqCst);
        let _guard = InFlight(&self.in_flight);

        if let Some(delay) = self.delays.get(&name) {
            tokio::time::sleep(*delay).await;
        }
        let step = self
            .steps
            .get(&name)
            .map(|steps| steps[(attempt - 1).min(steps.len() - 1)].clone())
            .unwrap_or(Step::Found(1000));
        let result = match step {
            Step::Found(cents) => Ok(found(&name, cents)),
            Step::Empty => Ok(ReceiptMeta {
                vendor: Some(format!("EXAMPLE ATTEMPT {attempt}")),
                ..unread(&name, "gemini")
            }),
            Step::Fail => Err(ExtractError::Failed("EXAMPLE FAILURE".into())),
            Step::Fatal => Err(ExtractError::Fatal("EXAMPLE FATAL".into())),
            Step::Hang => std::future::pending().await,
        };
        self.finished.lock().unwrap().push(name);
        result
    }
}

fn found(file: &str, cents: i64) -> ReceiptMeta {
    ReceiptMeta {
        file: file.to_string(),
        amount_cents: Some(cents),
        confidence: Some("high".into()),
        currency: Some("EUR".into()),
        vendor: Some("ACME CORP".into()),
        date: Some("2030-03-01".into()),
        provider_used: Some("gemini".into()),
        ..Default::default()
    }
}

fn receipt_path(name: &str) -> String {
    format!("/receipts/2030/03/receipts/{name}.pdf")
}

fn files(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| receipt_path(name)).collect()
}

fn ignore_progress(_: usize) {}

/// Counts how often each file is prepared and read, preparing once per file.
#[derive(Default)]
struct Preparing {
    prepared: Mutex<Vec<String>>,
    attempts: AtomicUsize,
}

#[async_trait]
impl ReceiptExtractor for Preparing {
    async fn prepare(&self, file: &Path) -> Result<Prepared, ExtractError> {
        self.prepared
            .lock()
            .unwrap()
            .push(file.to_string_lossy().into_owned());
        Ok(Prepared::default())
    }

    async fn extract_prepared(
        &self,
        file: &Path,
        _prepared: &Prepared,
    ) -> Result<ReceiptMeta, ExtractError> {
        let attempt = self.attempts.fetch_add(1, Ordering::SeqCst) + 1;
        let name = file.to_string_lossy();
        Ok(match attempt {
            3 => found(&name, 1000),
            _ => unread(&name, "gemini"),
        })
    }

    async fn extract(&self, _file: &Path) -> Result<ReceiptMeta, ExtractError> {
        unreachable!("extract_all prepares once and reads the prepared file")
    }
}

#[tokio::test(start_paused = true)]
async fn each_file_is_prepared_once_for_all_its_attempts() {
    let list = files(&["acme"]);
    let extractor = Preparing::default();
    let result = extract_all(
        &list,
        &[],
        false,
        &extractor,
        &ExtractOptions::default(),
        &ignore_progress,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(result[0].amount_cents, Some(1000));
    assert_eq!(extractor.attempts.load(Ordering::SeqCst), 3);
    assert_eq!(*extractor.prepared.lock().unwrap(), list);
}

/// Refuses every file as one that is not a receipt.
struct Refusing(AtomicUsize);

#[async_trait]
impl ReceiptExtractor for Refusing {
    async fn extract(&self, _file: &Path) -> Result<ReceiptMeta, ExtractError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(ExtractError::Rejected {
            code: "unrecognized_file",
            message: "EXAMPLE REFUSAL".into(),
        })
    }
}

#[tokio::test]
async fn a_refused_file_is_not_retried() {
    let list = files(&["acme"]);
    let extractor = Refusing(AtomicUsize::new(0));
    let result = extract_all(
        &list,
        &[],
        false,
        &extractor,
        &ExtractOptions::default(),
        &ignore_progress,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(
        result,
        vec![ReceiptMeta::refused(&list[0], "unrecognized_file")]
    );
    assert_eq!(extractor.0.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cache_hits_are_reported_together_before_extraction() {
    let list = files(&["a", "b", "c", "d"]);
    let cache = vec![
        found(&list[0], 100),
        found(&list[2], 300),
        found(&list[3], 400),
    ];
    let fake = Fake::new();
    let progress = Mutex::new(Vec::new());
    extract_all(
        &list,
        &cache,
        false,
        &fake,
        &ExtractOptions::default(),
        &|done| progress.lock().unwrap().push(done),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(*progress.lock().unwrap(), vec![3, 4]);
    assert_eq!(fake.total_calls(), 1);
}

async fn run(
    files: &[String],
    cache: &[ReceiptMeta],
    force: bool,
    fake: &Fake,
    options: &ExtractOptions,
) -> Result<Vec<ReceiptMeta>, ExtractAllError> {
    extract_all(
        files,
        cache,
        force,
        fake,
        options,
        &ignore_progress,
        &CancellationToken::new(),
    )
    .await
}

#[tokio::test]
async fn empty_file_list_returns_no_receipts() {
    let fake = Fake::new();
    let progress = Mutex::new(Vec::new());
    let result = extract_all(
        &[],
        &[found(&receipt_path("acme"), 1000)],
        false,
        &fake,
        &ExtractOptions::default(),
        &|done| progress.lock().unwrap().push(done),
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(result, Ok(vec![]));
    assert_eq!(fake.total_calls(), 0);
    assert!(progress.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn results_keep_input_order_when_later_files_finish_first() {
    let list = files(&["first", "second", "third"]);
    let fake = Fake::new()
        .script(&list[0], &[Step::Found(100)])
        .script(&list[1], &[Step::Found(200)])
        .script(&list[2], &[Step::Found(300)])
        .delay(&list[0], Duration::from_millis(300))
        .delay(&list[1], Duration::from_millis(200))
        .delay(&list[2], Duration::from_millis(100));

    let result = run(&list, &[], false, &fake, &ExtractOptions::default())
        .await
        .unwrap();

    let order: Vec<&str> = result.iter().map(|r| r.file.as_str()).collect();
    assert_eq!(order, list.iter().map(String::as_str).collect::<Vec<_>>());
    let amounts: Vec<Option<i64>> = result.iter().map(|r| r.amount_cents).collect();
    assert_eq!(amounts, vec![Some(100), Some(200), Some(300)]);
    let finished = fake.finished.lock().unwrap().clone();
    assert_eq!(
        finished,
        vec![list[2].clone(), list[1].clone(), list[0].clone()]
    );
}

#[tokio::test(start_paused = true)]
async fn at_most_concurrency_extractions_run_at_once() {
    let names: Vec<String> = (0..10).map(|i| format!("acme-{i}")).collect();
    let list: Vec<String> = names.iter().map(|n| receipt_path(n)).collect();
    let mut fake = Fake::new();
    for file in &list {
        fake = fake.delay(file, Duration::from_millis(100));
    }
    let options = ExtractOptions {
        concurrency: 3,
        ..ExtractOptions::default()
    };

    let result = run(&list, &[], false, &fake, &options).await.unwrap();

    assert_eq!(result.len(), 10);
    assert_eq!(fake.max_in_flight.load(Ordering::SeqCst), 3);
    assert_eq!(fake.in_flight.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn zero_concurrency_runs_one_at_a_time() {
    let list = files(&["acme", "example"]);
    let fake = Fake::new()
        .delay(&list[0], Duration::from_millis(100))
        .delay(&list[1], Duration::from_millis(100));
    let options = ExtractOptions {
        concurrency: 0,
        ..ExtractOptions::default()
    };

    let result = run(&list, &[], false, &fake, &options).await.unwrap();

    assert_eq!(result.len(), 2);
    assert_eq!(fake.max_in_flight.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn high_confidence_cache_entries_are_reused() {
    let list = files(&["cached", "fresh"]);
    let cached = ReceiptMeta {
        vendor: Some("ACME CACHED".into()),
        ..found(&list[0], 4500)
    };
    let fake = Fake::new().script(&list[1], &[Step::Found(2000)]);

    let result = run(
        &list,
        std::slice::from_ref(&cached),
        false,
        &fake,
        &ExtractOptions::default(),
    )
    .await
    .unwrap();

    assert_eq!(result[0], cached);
    assert_eq!(result[1], found(&list[1], 2000));
    assert!(fake.calls_for(&list[0]).is_empty());
    assert_eq!(fake.calls_for(&list[1]).len(), 1);
}

#[tokio::test]
async fn non_high_cache_entries_are_extracted_again() {
    let list = files(&["blurry", "unsure"]);
    let cache = vec![
        unread(&list[0], "gemini"),
        ReceiptMeta {
            confidence: Some("low".into()),
            ..found(&list[1], 9900)
        },
    ];
    let fake = Fake::new()
        .script(&list[0], &[Step::Found(1000)])
        .script(&list[1], &[Step::Found(2000)]);

    let result = run(&list, &cache, false, &fake, &ExtractOptions::default())
        .await
        .unwrap();

    assert_eq!(result, vec![found(&list[0], 1000), found(&list[1], 2000)]);
    assert_eq!(fake.total_calls(), 2);
}

#[tokio::test]
async fn cache_entries_for_other_files_are_ignored() {
    let list = files(&["acme"]);
    let cache = vec![found(&receipt_path("example"), 5000)];
    let fake = Fake::new().script(&list[0], &[Step::Found(1000)]);

    let result = run(&list, &cache, false, &fake, &ExtractOptions::default())
        .await
        .unwrap();

    assert_eq!(result, vec![found(&list[0], 1000)]);
}

#[tokio::test]
async fn force_ignores_the_cache() {
    let list = files(&["cached"]);
    let cache = vec![found(&list[0], 4500)];
    let fake = Fake::new().script(&list[0], &[Step::Found(1000)]);

    let result = run(&list, &cache, true, &fake, &ExtractOptions::default())
        .await
        .unwrap();

    assert_eq!(result, vec![found(&list[0], 1000)]);
    assert_eq!(fake.calls_for(&list[0]).len(), 1);
}

#[tokio::test(start_paused = true)]
async fn success_on_the_first_attempt_is_not_retried() {
    let list = files(&["acme"]);
    let fake = Fake::new().script(&list[0], &[Step::Found(1000)]);

    let result = run(&list, &[], false, &fake, &ExtractOptions::default())
        .await
        .unwrap();

    assert_eq!(result, vec![found(&list[0], 1000)]);
    assert_eq!(fake.total_calls(), 1);
}

#[tokio::test(start_paused = true)]
async fn missing_amount_is_retried_until_one_is_found() {
    let list = files(&["acme"]);
    let fake = Fake::new().script(&list[0], &[Step::Empty, Step::Empty, Step::Found(1250)]);

    let result = run(&list, &[], false, &fake, &ExtractOptions::default())
        .await
        .unwrap();

    assert_eq!(fake.calls_for(&list[0]).len(), 3);
    assert_eq!(result, vec![found(&list[0], 1250)]);
}

#[tokio::test(start_paused = true)]
async fn missing_amount_on_every_attempt_returns_the_last_result() {
    let list = files(&["acme"]);
    let fake = Fake::new().script(&list[0], &[Step::Empty]);

    let result = run(&list, &[], false, &fake, &ExtractOptions::default())
        .await
        .unwrap();

    assert_eq!(fake.calls_for(&list[0]).len(), 3);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].amount_cents, None);
    assert_eq!(result[0].provider_used.as_deref(), Some("gemini"));
    assert_eq!(result[0].vendor.as_deref(), Some("EXAMPLE ATTEMPT 3"));
}

#[tokio::test(start_paused = true)]
async fn failure_on_every_attempt_returns_an_error_entry() {
    let list = files(&["acme"]);
    let fake = Fake::new().script(&list[0], &[Step::Fail]);

    let result = run(&list, &[], false, &fake, &ExtractOptions::default())
        .await
        .unwrap();

    assert_eq!(fake.calls_for(&list[0]).len(), 3);
    assert_eq!(result, vec![unread(&list[0], "error")]);
    let entry = &result[0];
    assert_eq!(entry.provider_used.as_deref(), Some("error"));
    assert_eq!(entry.amount_cents, None);
    assert_eq!(entry.confidence, None);
    assert_eq!(entry.currency, None);
    assert_eq!(entry.vendor, None);
    assert_eq!(entry.date, None);
}

#[tokio::test(start_paused = true)]
async fn a_failed_attempt_keeps_the_previous_result() {
    let list = files(&["acme"]);
    let fake = Fake::new().script(&list[0], &[Step::Empty, Step::Fail]);

    let result = run(&list, &[], false, &fake, &ExtractOptions::default())
        .await
        .unwrap();

    assert_eq!(fake.calls_for(&list[0]).len(), 3);
    assert_eq!(result[0].provider_used.as_deref(), Some("gemini"));
    assert_eq!(result[0].vendor.as_deref(), Some("EXAMPLE ATTEMPT 1"));
}

#[tokio::test(start_paused = true)]
async fn retries_wait_zero_then_one_and_a_half_then_four_seconds() {
    let list = files(&["acme"]);
    let fake = Fake::new().script(&list[0], &[Step::Empty]);
    let start = Instant::now();

    run(&list, &[], false, &fake, &ExtractOptions::default())
        .await
        .unwrap();

    let calls = fake.calls_for(&list[0]);
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[0] - start, Duration::ZERO);
    assert_eq!(calls[1] - calls[0], Duration::from_millis(1500));
    assert_eq!(calls[2] - calls[1], Duration::from_millis(4000));
}

#[tokio::test(start_paused = true)]
async fn a_hung_attempt_times_out_and_is_retried() {
    let list = files(&["acme"]);
    let fake = Fake::new().script(&list[0], &[Step::Hang, Step::Found(1000)]);
    let options = ExtractOptions {
        attempt_timeout: Duration::from_secs(2),
        ..ExtractOptions::default()
    };

    let result = run(&list, &[], false, &fake, &options).await.unwrap();

    assert_eq!(result, vec![found(&list[0], 1000)]);
    let calls = fake.calls_for(&list[0]);
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[1] - calls[0], Duration::from_millis(3500));
    assert_eq!(fake.in_flight.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn hanging_on_every_attempt_returns_an_error_entry() {
    let list = files(&["acme"]);
    let fake = Fake::new().script(&list[0], &[Step::Hang]);
    let options = ExtractOptions {
        attempt_timeout: Duration::from_secs(2),
        ..ExtractOptions::default()
    };

    let result = run(&list, &[], false, &fake, &options).await.unwrap();

    assert_eq!(result, vec![unread(&list[0], "error")]);
    assert_eq!(fake.calls_for(&list[0]).len(), 3);
}

#[tokio::test(start_paused = true)]
async fn a_fatal_error_stops_the_run() {
    let list = files(&["acme", "example", "other"]);
    let fake = Fake::new().script(&list[1], &[Step::Fatal]);

    let result = run(&list, &[], false, &fake, &ExtractOptions::default()).await;

    assert_eq!(result, Err(ExtractAllError::Fatal("EXAMPLE FATAL".into())));
    assert_eq!(fake.calls_for(&list[1]).len(), 1, "fatal is not retried");
}

#[tokio::test(start_paused = true)]
async fn a_fatal_error_after_a_retry_stops_the_run() {
    let list = files(&["acme"]);
    let fake = Fake::new().script(&list[0], &[Step::Fail, Step::Fatal]);

    let result = run(&list, &[], false, &fake, &ExtractOptions::default()).await;

    assert_eq!(result, Err(ExtractAllError::Fatal("EXAMPLE FATAL".into())));
    assert_eq!(fake.calls_for(&list[0]).len(), 2);
}

#[tokio::test(start_paused = true)]
async fn cancelling_during_an_attempt_returns_promptly() {
    let list = files(&["acme", "example"]);
    let fake = Fake::new()
        .script(&list[0], &[Step::Hang])
        .script(&list[1], &[Step::Hang]);
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        trigger.cancel();
    });
    let start = Instant::now();

    let result = extract_all(
        &list,
        &[],
        false,
        &fake,
        &ExtractOptions::default(),
        &ignore_progress,
        &cancel,
    )
    .await;

    assert_eq!(result, Err(ExtractAllError::Cancelled));
    assert_eq!(start.elapsed(), Duration::from_millis(50));
    assert_eq!(fake.in_flight.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn cancelling_during_a_backoff_wait_returns_promptly() {
    let list = files(&["acme"]);
    let fake = Fake::new().script(&list[0], &[Step::Empty]);
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        trigger.cancel();
    });
    let start = Instant::now();

    let result = extract_all(
        &list,
        &[],
        false,
        &fake,
        &ExtractOptions::default(),
        &ignore_progress,
        &cancel,
    )
    .await;

    assert_eq!(result, Err(ExtractAllError::Cancelled));
    assert_eq!(start.elapsed(), Duration::from_millis(500));
    assert_eq!(fake.calls_for(&list[0]).len(), 1);
}

#[tokio::test]
async fn an_already_cancelled_token_returns_cancelled() {
    let list = files(&["acme"]);
    // A hanging extractor keeps the work from finishing in the same poll as the cancellation.
    let fake = Fake::new().script(&list[0], &[Step::Hang]);
    let cancel = CancellationToken::new();
    cancel.cancel();

    let result = extract_all(
        &list,
        &[],
        false,
        &fake,
        &ExtractOptions::default(),
        &ignore_progress,
        &cancel,
    )
    .await;

    assert_eq!(result, Err(ExtractAllError::Cancelled));
}

#[tokio::test(start_paused = true)]
async fn progress_counts_every_file_including_cache_hits() {
    let list = files(&["acme", "cached", "example", "other"]);
    let cache = vec![found(&list[1], 4500)];
    let fake = Fake::new()
        .delay(&list[0], Duration::from_millis(300))
        .delay(&list[2], Duration::from_millis(100))
        .script(&list[3], &[Step::Empty, Step::Found(1000)]);
    let progress = Mutex::new(Vec::new());

    let result = extract_all(
        &list,
        &cache,
        false,
        &fake,
        &ExtractOptions::default(),
        &|done| progress.lock().unwrap().push(done),
        &CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(result.len(), 4);
    assert_eq!(*progress.lock().unwrap(), vec![1, 2, 3, 4]);
}
