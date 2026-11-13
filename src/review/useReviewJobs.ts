import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorKind } from "../lib/errors";
import { useDockProgress } from "../lib/hooks/useDockProgress";
import { useLatest } from "../lib/hooks/useLatest";
import { useRun } from "../lib/hooks/useRun";
import type { Statement } from "../lib/statements";
import { startAddStatements, startScan, type DroppedDecision, type RunEvent, type RunHandle } from "../lib/tauri";
import { addNotice, scanNotice, type Notice } from "./notices";

/** A run inside the review: a scan for new receipts, or statements being added. */
export type JobKind = "scan" | "add";

/** What a scan or added statements changed: decisions dropped, and the line that sums it up. */
export type JobOutcome = { dropped: DroppedDecision[]; notice: Notice };

/** A run whose result is summed up as a `JobOutcome` once it ends. */
function withOutcome<T>(handle: RunHandle<T>, outcome: (result: T) => JobOutcome): RunHandle<JobOutcome> {
  return { ...handle, promise: handle.promise.then(outcome) };
}

interface ReviewJobsOptions {
  year: string;
  month: string;
  /** Saves pending decisions, which a run starts after. */
  flush: () => Promise<void>;
  /** Loads the month again after a run changed it. */
  load: () => void;
  /** Runs after a run changes what the month holds. */
  onChanged?: () => void;
  onError: (e: unknown) => void;
  setNotice: (notice: Notice | null) => void;
  /** Clears the statements chosen in the Add Statements sheet. */
  clearAdding: () => void;
}

/**
 * The scan and add-statements runs of a review: starts them, follows their progress, and hands a
 * finished run's outcome to the review.
 */
export function useReviewJobs({ year, month, flush, load, onChanged, onError, setNotice, clearAdding }: ReviewJobsOptions) {
  const { t } = useTranslation();
  const job = useRun<JobOutcome>();
  const [jobKind, setJobKind] = useState<JobKind>("scan");
  const [dropped, setDropped] = useState<DroppedDecision[]>([]);
  /** Starts the last run again, for Try Again. */
  const lastJob = useRef<(() => void) | null>(null);
  const { state: jobState, reset: resetJob } = job;
  const latestOnChanged = useLatest(onChanged);
  const latestSetNotice = useLatest(setNotice);
  const latestClearAdding = useLatest(clearAdding);
  useDockProgress(jobState, job.events);

  /** Saves pending decisions, then starts a run; Try Again starts it the same way. */
  function runJob(kind: JobKind, launch: (onEvent: (event: RunEvent) => void) => RunHandle<JobOutcome>) {
    setDropped([]);
    setNotice(null);
    setJobKind(kind);
    lastJob.current = () => runJob(kind, launch);
    flush()
      .then(() => job.start(launch))
      .catch(onError);
  }

  function startScanning() {
    runJob("scan", (onEvent) => withOutcome(startScan(year, month, onEvent), (result) => ({ dropped: result.dropped_decisions, notice: scanNotice(result, t) })));
  }

  function startAdding(files: Statement[]) {
    const inputs = files.map(({ path, bank }) => ({ path, bank }));
    runJob("add", (onEvent) =>
      withOutcome(startAddStatements(year, month, inputs, onEvent), (result) => ({ dropped: result.dropped_decisions, notice: addNotice(result, t) })),
    );
  }

  useEffect(() => {
    if (jobState.phase === "succeeded") {
      setDropped(jobState.result.dropped);
      latestSetNotice.current(jobState.result.notice);
      latestClearAdding.current();
      resetJob();
      load();
      latestOnChanged.current?.();
    } else if (jobState.phase === "failed" && errorKind(jobState.error) === "cancelled") {
      // A run the user stopped closes its sheet, back to the chosen statements when adding.
      resetJob();
    }
  }, [jobState, resetJob, load, latestOnChanged, latestSetNotice, latestClearAdding]);

  /** Closes a failed run's sheet and drops the statements it was adding. */
  function closeJob() {
    resetJob();
    clearAdding();
  }

  return { job, jobKind, dropped, setDropped, startScanning, startAdding, retry: () => lastJob.current?.(), closeJob };
}
