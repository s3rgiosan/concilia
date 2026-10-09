import "./Review.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { friendlyError } from "../lib/errors";
import { useRun } from "../lib/hooks/useRun";
import { periodLabel, type Period } from "../lib/period";
import { buildSteps } from "../lib/steps";
import {
  exportReport,
  finalize,
  getDraft,
  getReview,
  openReceipt,
  periodStatus,
  rescanReceipt,
  rescanReimbursement,
  saveDraft,
  startScan,
  type DroppedDecision,
  type Draft,
  type ReceiptMeta,
  type ReviewData,
  type Transaction,
} from "../lib/tauri";
import { RunProgress } from "../main/RunProgress";
import { assign, confirm, forDraft, noReceipt, patchDraftReceipt, unmatch, type Decision } from "./decisions";
import {
  claimedFiles,
  filterCounts,
  mergeDraft,
  patchReceipt,
  relPaths,
  unmatchedPool,
  visibleTransactions,
  type Filter,
} from "./effective";
import { FinalizeSheet } from "./FinalizeSheet";
import { PreviewPane } from "./PreviewPane";
import { Reimbursements } from "./Reimbursements";
import { TransactionRow, type RowHandlers } from "./TransactionRow";
import { useDraftAutosave, type SaveState } from "./useDraftAutosave";

const FILTERS: Filter[] = ["all", "review", "unmatched", "matched"];

type Loaded = { data: ReviewData; draft: Draft; applied: boolean };

/** The review of a month's matches: decisions save as a draft until Finalize applies them. */
export function Review({ period, onBack, onError }: { period: Period; onBack: () => void; onError: (e: unknown) => void }) {
  const { t } = useTranslation();
  const { year, month } = period;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [dirty, setDirty] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<ReceiptMeta | null>(null);
  const [rescanning, setRescanning] = useState<Set<string>>(new Set());
  const [dropped, setDropped] = useState<DroppedDecision[]>([]);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const scan = useRun<{ dropped: DroppedDecision[] }>();

  const save = useCallback((next: Draft) => saveDraft(year, month, next), [year, month]);
  const autosave = useDraftAutosave(draft, dirty, save);

  const load = useCallback(() => {
    setLoadError(null);
    Promise.all([getReview(year, month), getDraft(year, month), periodStatus(year, month)]).then(
      ([data, stored, status]) => {
        setLoaded({ data, draft: stored, applied: status.applied });
        setDraft(stored);
        setDirty(false);
        // Everything that still needs a decision starts open.
        setExpanded(new Set(mergeDraft(data.transactions, stored).filter((tx) => tx.status !== "MATCHED").map((tx) => tx.id)));
      },
      (e) => setLoadError(e),
    );
  }, [year, month]);

  useEffect(load, [load]);

  const data = loaded?.data ?? null;
  const paths = useMemo(() => (data ? relPaths(data) : new Map<string, string>()), [data]);
  const merged = useMemo(() => (data ? mergeDraft(data.transactions, draft, paths) : []), [data, draft, paths]);
  const claimed = useMemo(() => claimedFiles(merged), [merged]);
  const pool = useMemo(() => (data ? unmatchedPool(data, merged) : []), [data, merged]);
  const counts = useMemo(() => filterCounts(merged), [merged]);
  const visible = useMemo(() => visibleTransactions(merged, filter, search), [merged, filter, search]);

  function decide(tx: Transaction, decision: Decision) {
    setDraft((prev) => ({ ...prev, [tx.id]: forDraft(decision) }));
    setDirty(true);
  }

  async function rescan(receipt: ReceiptMeta, reimbursement: boolean) {
    if (!receipt.rel_path || rescanning.has(receipt.file)) {
      return;
    }
    const relPath = receipt.rel_path;
    setRescanning((prev) => new Set(prev).add(receipt.file));
    try {
      const meta = await (reimbursement ? rescanReimbursement : rescanReceipt)(year, month, relPath);
      setLoaded((prev) => (prev ? { ...prev, data: patchReceipt(prev.data, meta) } : prev));
      // Decisions keep their own copy of each receipt; they take the new reading too.
      setDraft((prev) => {
        const { draft: next, changed } = patchDraftReceipt(prev, meta);
        if (changed) {
          setDirty(true);
        }
        return next;
      });
      setPreview((prev) => (prev?.file === meta.file ? { ...meta, rel_path: meta.rel_path ?? relPath } : prev));
    } catch (e) {
      onError(e);
    } finally {
      setRescanning((prev) => {
        const next = new Set(prev);
        next.delete(receipt.file);
        return next;
      });
    }
  }

  const handlers: RowHandlers = {
    onConfirm: (tx, receipt) => decide(tx, confirm(tx, receipt)),
    onUnmatch: (tx) => decide(tx, unmatch()),
    onAssign: (tx, receipt) => decide(tx, assign(receipt)),
    onNoReceipt: (tx, category) => decide(tx, noReceipt(category)),
    onRescan: (receipt) => rescan(receipt, false),
    onPreview: (_tx, receipt) => setPreview(receipt),
  };

  function startScanning() {
    setDropped([]);
    autosave
      .flush()
      .then(() =>
        scan.start((onEvent) => {
          const handle = startScan(year, month, onEvent);
          return { ...handle, promise: handle.promise.then((result) => ({ dropped: result.dropped_decisions })) };
        }),
      )
      .catch(onError);
  }

  const { state: scanState, reset: resetScan } = scan;
  useEffect(() => {
    if (scanState.phase === "succeeded") {
      setDropped(scanState.result.dropped);
      resetScan();
      load();
    }
  }, [scanState, resetScan, load]);

  function saveReport() {
    autosave
      .flush()
      .then(() => exportReport(year, month))
      .then((path) => {
        if (path) {
          setNotice(t("results.reportSaved", { path }));
        }
      })
      .catch(onError);
  }

  function runFinalize() {
    setFinalizing(true);
    autosave
      .flush()
      .then(() => finalize(year, month))
      .then(() => {
        setConfirmFinalize(false);
        setNotice(t("review.changesApplied"));
        load();
      })
      .catch(onError)
      .finally(() => setFinalizing(false));
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const allOpen = visible.length > 0 && visible.every((tx) => expanded.has(tx.id));
  function toggleAll() {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const tx of visible) {
        if (allOpen) {
          next.delete(tx.id);
        } else {
          next.add(tx.id);
        }
      }
      return next;
    });
  }

  if (loadError) {
    return (
      <section className="review review--message">
        <div className="banner banner--error" role="alert">
          <Icon name="warning" size={14} />
          <span className="grow">{friendlyError(loadError, t)}</span>
          <button type="button" className="banner__action" onClick={onBack}>
            {t("review.back")}
          </button>
        </div>
      </section>
    );
  }
  if (!loaded || !data) {
    return null;
  }

  const scanning = scan.state.phase === "running" || scan.state.phase === "failed";
  const busy = finalizing || scan.state.phase === "running";

  return (
    <section className="review" aria-labelledby="review-title">
      <header className="review__toolbar">
        <button type="button" onClick={onBack}>
          {t("review.back")}
        </button>
        <h1 id="review-title" className="review__title">
          {t("review.title", { period: periodLabel(period, t) })}
        </h1>
        <div className="segmented" role="group" aria-label={t("review.title", { period: periodLabel(period, t) })}>
          {FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              className={`segmented__item ${filter === key ? "segmented__item--on" : ""}`}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {t(`review.filters.${key}`)}
              <span className="segmented__count numeric">{counts[key]}</span>
            </button>
          ))}
        </div>
        <label className="search review__search">
          <Icon name="search" size={13} />
          <input type="search" value={search} placeholder={t("review.search")} aria-label={t("review.search")} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button type="button" onClick={toggleAll} disabled={visible.length === 0}>
          {allOpen ? t("review.collapse") : t("review.expand")}
        </button>
      </header>

      {loaded.applied ? (
        <div className="banner banner--info" role="status">
          <Icon name="check" size={14} />
          <span>{t("review.finalizedNote")}</span>
        </div>
      ) : null}
      {notice ? (
        <div className="banner banner--info" role="status">
          <Icon name="check" size={14} />
          <span className="grow">{notice}</span>
          <button type="button" className="icon" aria-label={t("common.close")} onClick={() => setNotice(null)}>
            <Icon name="xmark" size={12} />
          </button>
        </div>
      ) : null}
      {dropped.length > 0 ? (
        <div className="banner banner--warn" role="status">
          <Icon name="warning" size={14} />
          <span className="grow">
            {t("review.scanDroppedBanner", { count: dropped.length, names: dropped.map((d) => d.description).join(", ") })}
          </span>
          <button type="button" className="banner__action" onClick={() => setDropped([])}>
            {t("review.scanDroppedDismiss")}
          </button>
        </div>
      ) : null}

      <div className="review__split">
        <div className="review__list">
          {visible.length === 0 ? <p className="muted review__empty">{t("review.noTransactions")}</p> : null}
          <ul className="tx-list">
            {visible.map((tx) => (
              <TransactionRow
                key={tx.id}
                tx={tx}
                expanded={expanded.has(tx.id)}
                onToggle={() => toggle(tx.id)}
                pool={pool}
                claimed={claimed}
                rescanning={rescanning}
                selectedFile={preview?.file ?? null}
                handlers={handlers}
              />
            ))}
          </ul>
          <Reimbursements
            receipts={data.reimbursements}
            rescanning={rescanning}
            selectedFile={preview?.file ?? null}
            onPreview={setPreview}
            onRescan={(r) => rescan(r, true)}
          />
        </div>
        <PreviewPane
          receipt={preview}
          onOpen={(r) => {
            if (r.rel_path) {
              openReceipt(year, month, r.rel_path).catch(onError);
            }
          }}
          onClose={() => setPreview(null)}
        />
      </div>

      <footer className="review__footer">
        <SaveStatus state={autosave.state} />
        <span className="grow" />
        <button type="button" onClick={startScanning} disabled={busy || loaded.applied}>
          {t("form.scan")}
        </button>
        <button type="button" onClick={saveReport} disabled={busy}>
          {t("results.saveReport")}
        </button>
        <button type="button" className="default" onClick={() => setConfirmFinalize(true)} disabled={busy}>
          {t("review.finalize")}
        </button>
      </footer>

      {scanning && scan.state.phase !== "idle" && scan.state.phase !== "succeeded" ? (
        <div className="sheet-backdrop">
          <div className="sheet sheet--wide" role="dialog" aria-modal="true" aria-label={t("review.scanTitle")}>
            <RunProgress
              title={t("review.scanTitle")}
              steps={buildSteps("scan", scan.state.events, scan.state.phase === "failed" ? "failed" : null, t)}
              running={scan.state.phase === "running"}
              cancelling={scan.state.phase === "running" && scan.state.cancelling}
              onCancel={scan.cancel}
            />
            {scan.state.phase === "failed" ? (
              <>
                <div className="banner banner--error" role="alert">
                  <Icon name="warning" size={14} />
                  <span>{friendlyError(scan.state.error, t)}</span>
                </div>
                <div className="sheet__actions">
                  <button type="button" className="default" onClick={scan.reset}>
                    {t("common.close")}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {confirmFinalize ? <FinalizeSheet busy={finalizing} onCancel={() => setConfirmFinalize(false)} onConfirm={runFinalize} /> : null}
    </section>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  const { t } = useTranslation();
  switch (state.kind) {
    case "saving":
      return <span className="muted review__save">{t("review.saveState.saving")}</span>;
    case "saved":
      return <span className="muted review__save">{t("review.saveState.saved")}</span>;
    case "failed":
      return (
        <span className="review__save review__save--failed" role="alert">
          <Icon name="warning" size={12} /> {t("review.saveState.failed", { message: friendlyError(state.error, t) })}
        </span>
      );
    case "idle":
    default:
      return null;
  }
}
