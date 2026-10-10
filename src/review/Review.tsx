import "./Review.css";
import { useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import type { PopUpAction } from "../components/PopUpButton";
import { ToolbarPortal, type ToolbarSlots } from "../components/Toolbar";
import { friendlyError } from "../lib/errors";
import { useLatest } from "../lib/hooks/useLatest";
import { useDockProgress } from "../lib/hooks/useDockProgress";
import { useRun } from "../lib/hooks/useRun";
import { useSafeStorage } from "../lib/hooks/useSafeStorage";
import { useToolbarRoom } from "../lib/hooks/useToolbarRoom";
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
import type { ReviewAvailability, ReviewCommands } from "./commands";
import { assign, changedIds, confirm, forDraft, noReceipt, patchDraftReceipt, unmatch, type Decision } from "./decisions";
import {
  claimedFiles,
  filterCounts,
  finalizeCounts,
  mergeDraft,
  patchReceipt,
  pendingCount,
  relPaths,
  unmatchedPool,
  visibleReimbursements,
  visibleTransactions,
  type Filter,
  type NoReceiptCategory,
} from "./effective";
import { FinalizeSheet } from "./FinalizeSheet";
import { useHistory } from "./history";
import { Inspector, type InspectorHandlers } from "./Inspector";
import { QuickLook } from "./QuickLook";
import { ReviewToolbar } from "./ReviewToolbar";
import { buildRows, findPending, initialSelection, resolveSelection, rowReceipts, type ListRow } from "./rows";
import { TransactionList } from "./TransactionList";
import { useDraftAutosave, type SaveState } from "./useDraftAutosave";

type Loaded = { data: ReviewData; applied: boolean };

/** Toolbar width, without the leading area, below which the review's controls go compact. */
const COMPACT_TOOLBAR = 970;

/** The selected row, and where it was in the list, so the row after it takes over if it leaves. */
type Selection = { id: string | null; index: number };

/** The receipt focused in the inspector, for the row it was focused in. */
type Focus = { rowId: string; file: string } | null;

export interface ReviewProps {
  period: Period;
  /** The window toolbar's slots, which the review fills with its subtitle and controls. */
  toolbar: ToolbarSlots;
  /** The month's status line, shown until the review has loaded. */
  status: string;
  /** The figures of the run that produced this review, shown until the first change. */
  runSummary?: string;
  /** The month's other actions for the toolbar's `•••` menu. */
  moreActions: PopUpAction[];
  /** Runs after a scan or Finalize changes what the month holds. */
  onChanged?: () => void;
  onError: (e: unknown) => void;
  /** Runs whenever the commands that can run change, such as for the app menu. */
  onAvailabilityChange?: (can: ReviewAvailability) => void;
  /** Runs whenever the inspector is shown or hidden, such as for the app menu's label. */
  onInspectorChange?: (shown: boolean) => void;
  ref?: Ref<ReviewCommands>;
}

/**
 * The review of a month's matches: a list of transactions beside an inspector for the selected
 * one. Decisions save as a draft until Finalize applies them, and each can be undone.
 */
export function Review({ period, toolbar, status, runSummary, moreActions, onChanged, onError, onAvailabilityChange, onInspectorChange, ref }: ReviewProps) {
  const { t } = useTranslation();
  const { year, month } = period;
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const history = useHistory<Draft>({});
  const [dirty, setDirty] = useState(false);
  const [filter, setFilterState] = useState<Filter>("all");
  const [search, setSearchState] = useState("");
  const [selection, setSelection] = useState<Selection>({ id: null, index: 0 });
  const [focus, setFocus] = useState<Focus>(null);
  const [quickLook, setQuickLook] = useState(false);
  const [rescanning, setRescanning] = useState<Set<string>>(new Set());
  const [dropped, setDropped] = useState<DroppedDecision[]>([]);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [inspectorSetting, setInspectorSetting] = useSafeStorage("review.inspector", "shown");
  const scan = useRun<{ dropped: DroppedDecision[] }>();
  useDockProgress(scan.state);
  const toolbarRoom = useToolbarRoom(toolbar.trailing);

  const draft = history.present;
  const latestDraft = useLatest(draft);
  const save = useCallback((next: Draft) => saveDraft(year, month, next), [year, month]);
  const autosave = useDraftAutosave(draft, dirty, save);

  // The month list shows how many transactions are left, so it refreshes after each save.
  const saveKind = autosave.state.kind;
  const latestOnChanged = useLatest(onChanged);
  useEffect(() => {
    if (saveKind === "saved") {
      latestOnChanged.current?.();
    }
  }, [saveKind, latestOnChanged]);

  const { reset: resetHistory, map: mapHistory } = history;
  const { forget: forgetSaveState } = autosave;
  const load = useCallback(() => {
    setLoadError(null);
    Promise.all([getReview(year, month), getDraft(year, month), periodStatus(year, month)]).then(
      ([data, stored, periodState]) => {
        setLoaded({ data, applied: periodState.applied });
        resetHistory(stored);
        setDirty(false);
        forgetSaveState();
      },
      (e) => setLoadError(e),
    );
  }, [year, month, resetHistory, forgetSaveState]);

  useEffect(load, [load]);

  const data = loaded?.data ?? null;
  const applied = loaded?.applied ?? false;
  const paths = useMemo(() => (data ? relPaths(data) : new Map<string, string>()), [data]);
  const merged = useMemo(() => (data ? mergeDraft(data.transactions, draft, paths) : []), [data, draft, paths]);
  const claimed = useMemo(() => claimedFiles(merged), [merged]);
  const pool = useMemo(() => (data ? unmatchedPool(data, merged) : []), [data, merged]);
  const counts = useMemo(() => filterCounts(merged), [merged]);
  const pending = pendingCount(merged);
  const visible = useMemo(() => visibleTransactions(merged, filter, search), [merged, filter, search]);
  const shownReimbursements = useMemo(() => (data ? visibleReimbursements(data.reimbursements, filter, search) : []), [data, filter, search]);
  const rows = useMemo(() => buildRows(visible, shownReimbursements), [visible, shownReimbursements]);
  const reimbursementTotal = data ? data.reimbursements.reduce((sum, r) => sum + (r.amount_cents ?? 0), 0) : 0;

  const selected = selection.id === null ? initialSelection(rows) : resolveSelection(rows, selection.id, selection.index);
  const selectedIndex = selected ? rows.indexOf(selected) : -1;
  const selectedTx = selected?.kind === "transaction" ? selected.tx : null;

  // The selection follows its row through filtering and decisions, or moves to the row resolved for it.
  useEffect(() => {
    if (selected && (selected.id !== selection.id || selectedIndex !== selection.index)) {
      setSelection({ id: selected.id, index: selectedIndex });
    }
  }, [selected, selectedIndex, selection]);

  const receipts = useMemo(() => rowReceipts(selected, pool, claimed), [selected, pool, claimed]);
  const focusedChoice = focus && selected && focus.rowId === selected.id ? receipts.find((r) => r.file === focus.file) : undefined;
  const focused = focusedChoice ?? receipts[0] ?? null;

  const scanning = scan.state.phase === "running";
  const busy = finalizing || scanning;
  const ready = loaded !== null;
  const inspectorShown = inspectorSetting !== "hidden";

  const nextPendingIndex = findPending(rows, selectedIndex, 1);
  const previousPendingIndex = findPending(rows, selectedIndex < 0 ? rows.length : selectedIndex, -1);
  const can: ReviewAvailability = {
    accept: selectedTx !== null && selectedTx.status !== "MATCHED" && focused !== null && !busy,
    reject: selectedTx !== null && selectedTx.status !== "UNMATCHED" && !busy,
    noReceipt: selectedTx !== null && selectedTx.status !== "MATCHED" && !busy,
    rescan: Boolean(focused?.rel_path) && !rescanning.has(focused?.file ?? ""),
    quickLook: Boolean(focused?.rel_path),
    openInPreview: Boolean(focused?.rel_path),
    nextPending: nextPendingIndex >= 0,
    previousPending: previousPendingIndex >= 0,
    undo: history.canUndo && !busy,
    redo: history.canRedo && !busy,
    setFilter: ready,
    focusSearch: ready,
    toggleInspector: ready,
    scan: ready && !busy && !applied,
    exportReport: ready && !busy,
    finalize: ready && !busy && !applied,
  };

  function selectRow(row: ListRow) {
    setSelection({ id: row.id, index: rows.indexOf(row) });
  }

  function decide(tx: Transaction, decision: Decision) {
    history.record((prev) => ({ ...prev, [tx.id]: forDraft(decision) }));
    setDirty(true);
  }

  /** Accepts a REVIEW candidate, or assigns a pool receipt to an UNMATCHED transaction. */
  function acceptReceipt(tx: Transaction, receipt: ReceiptMeta) {
    decide(tx, tx.status === "REVIEW" ? confirm(tx, receipt) : assign(receipt));
  }

  /** Steps through the history and selects the transaction whose decision changed. */
  function step(direction: "undo" | "redo") {
    const other = direction === "undo" ? history.previous : history.next;
    if (other === undefined || busy) {
      return;
    }
    const target = changedIds(history.present, other)[0];
    if (direction === "undo") {
      history.undo();
    } else {
      history.redo();
    }
    setDirty(true);
    if (target) {
      setSelection((prev) => ({ id: target, index: prev.index }));
    }
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
      if (patchDraftReceipt(latestDraft.current, meta).changed) {
        setDirty(true);
      }
      mapHistory((value) => patchDraftReceipt(value, meta).draft);
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

  function open(receipt: ReceiptMeta) {
    if (receipt.rel_path) {
      openReceipt(year, month, receipt.rel_path).catch(onError);
    }
  }

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
      onChanged?.();
    }
  }, [scanState, resetScan, load, onChanged]);

  function saveReport() {
    autosave
      .flush()
      .then(() => exportReport(year, month))
      .catch(onError);
  }

  function runFinalize() {
    setFinalizing(true);
    autosave
      .flush()
      .then(() => finalize(year, month))
      .then(() => {
        setConfirmFinalize(false);
        load();
        onChanged?.();
      })
      .catch(onError)
      .finally(() => setFinalizing(false));
  }

  function setFilter(next: Filter) {
    setFilterState(next);
    setSelection((prev) => ({ ...prev, index: 0 }));
  }

  function setSearch(next: string) {
    setSearchState(next);
    setSelection((prev) => ({ ...prev, index: 0 }));
  }

  function jumpPending(direction: 1 | -1) {
    const index = direction === 1 ? nextPendingIndex : previousPendingIndex;
    if (index >= 0) {
      selectRow(rows[index]);
    }
  }

  const commands: ReviewCommands = {
    accept: () => {
      if (can.accept && selectedTx && focused) {
        acceptReceipt(selectedTx, focused);
      }
    },
    reject: () => {
      if (can.reject && selectedTx) {
        decide(selectedTx, unmatch());
      }
    },
    noReceipt: (category: NoReceiptCategory) => {
      if (can.noReceipt && selectedTx) {
        decide(selectedTx, noReceipt(category));
      }
    },
    rescan: () => {
      if (can.rescan && focused && selected) {
        void rescan(focused, selected.kind === "reimbursement");
      }
    },
    quickLook: () => {
      if (can.quickLook) {
        setQuickLook((shown) => !shown);
      }
    },
    openInPreview: () => {
      if (can.openInPreview && focused) {
        open(focused);
      }
    },
    nextPending: () => jumpPending(1),
    previousPending: () => jumpPending(-1),
    undo: () => step("undo"),
    redo: () => step("redo"),
    setFilter: (next: Filter) => {
      if (can.setFilter) {
        setFilter(next);
      }
    },
    focusSearch: () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    },
    toggleInspector: () => setInspectorSetting(inspectorShown ? "hidden" : "shown"),
    scan: () => {
      if (can.scan) {
        startScanning();
      }
    },
    exportReport: () => {
      if (can.exportReport) {
        saveReport();
      }
    },
    finalize: () => {
      if (can.finalize) {
        setConfirmFinalize(true);
      }
    },
    can,
  };

  useImperativeHandle(ref, () => commands);

  const canKey = JSON.stringify(can);
  const reportAvailability = useLatest(onAvailabilityChange);
  useEffect(() => {
    reportAvailability.current?.(JSON.parse(canKey) as ReviewAvailability);
  }, [canKey, reportAvailability]);

  const reportInspector = useLatest(onInspectorChange);
  useEffect(() => {
    reportInspector.current?.(inspectorShown);
  }, [inspectorShown, reportInspector]);

  function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }
    let target: number;
    switch (e.key) {
      case "ArrowDown":
        target = Math.min(selectedIndex + 1, rows.length - 1);
        break;
      case "ArrowUp":
        target = Math.max(selectedIndex - 1, 0);
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = rows.length - 1;
        break;
      case " ":
        e.preventDefault();
        commands.quickLook();
        return;
      case "Enter":
        e.preventDefault();
        commands.accept();
        return;
      default:
        return;
    }
    e.preventDefault();
    if (rows[target]) {
      selectRow(rows[target]);
    }
  }

  function onSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        if (search) {
          setSearch("");
        } else {
          listRef.current?.focus();
        }
        break;
      case "ArrowDown":
      case "Enter":
        e.preventDefault();
        listRef.current?.focus();
        break;
      default:
        break;
    }
  }

  const touched = history.canUndo || history.canRedo || autosave.state.kind !== "idle";
  let statusText = status;
  if (loaded) {
    if (runSummary && !touched) {
      statusText = runSummary;
    } else if (applied) {
      statusText = t("month.status.finalized");
    } else {
      statusText = pending > 0 ? t("month.status.inReviewPending", { count: pending }) : t("month.status.inReview");
    }
  }
  const subtitle = (
    <ToolbarPortal target={toolbar.subtitle}>
      {statusText}
      <SaveStatus state={autosave.state} />
    </ToolbarPortal>
  );

  if (loadError) {
    return (
      <section className="review review--message">
        {subtitle}
        <div className="banner banner--error" role="alert">
          <Icon name="warning" size={14} />
          <span className="grow">{friendlyError(loadError, t)}</span>
          <button type="button" className="banner__action" onClick={load}>
            {t("common.tryAgain")}
          </button>
        </div>
      </section>
    );
  }
  if (!loaded || !data) {
    return subtitle;
  }

  const handlers: InspectorHandlers = {
    onFocusReceipt: (receipt) => {
      if (selected) {
        setFocus({ rowId: selected.id, file: receipt.file });
      }
    },
    onAccept: (receipt) => {
      if (selectedTx && !busy) {
        acceptReceipt(selectedTx, receipt);
      }
    },
    onReject: commands.reject,
    onNoReceipt: commands.noReceipt,
    onRescan: (receipt) => {
      void rescan(receipt, selected?.kind === "reimbursement");
    },
    onOpen: open,
    onQuickLook: () => setQuickLook(true),
  };

  return (
    <section className="review" aria-label={t("review.title", { period: periodLabel(period, t) })}>
      {subtitle}
      <ToolbarPortal target={toolbar.trailing}>
        <ReviewToolbar
          filter={filter}
          counts={counts}
          onFilter={setFilter}
          search={search}
          searchRef={searchRef}
          onSearch={setSearch}
          onSearchKeyDown={onSearchKeyDown}
          busy={busy}
          finalized={applied}
          moreActions={moreActions}
          inspectorShown={inspectorShown}
          onScan={commands.scan}
          onExport={commands.exportReport}
          onFinalize={commands.finalize}
          onToggleInspector={commands.toggleInspector}
          compact={toolbarRoom !== null && toolbarRoom < COMPACT_TOOLBAR}
        />
      </ToolbarPortal>

      <div className="review__main">
        {dropped.length > 0 ? (
          <div className="banner banner--warn review__banner" role="status">
            <Icon name="warning" size={14} />
            <span className="grow">
              {t("review.scanDroppedBanner", { count: dropped.length, names: dropped.map((d) => d.description).join(", ") })}
            </span>
            <button type="button" className="icon" aria-label={t("common.dismiss")} title={t("common.dismiss")} onClick={() => setDropped([])}>
              <Icon name="xmark" size={12} />
            </button>
          </div>
        ) : null}
        <div className="review__list">
          <TransactionList
            listId={listId}
            rows={rows}
            selectedId={selected?.id ?? null}
            reimbursementTotal={reimbursementTotal}
            listRef={listRef}
            onSelect={selectRow}
            onOpen={(row) => {
              selectRow(row);
              setQuickLook(true);
            }}
            onKeyDown={onListKeyDown}
          />
          {rows.length === 0 ? <p className="review__empty">{t("review.noTransactions")}</p> : null}
        </div>
      </div>

      {inspectorShown ? <Inspector row={selected} receipts={receipts} focused={focused} rescanning={rescanning} handlers={handlers} /> : null}

      {quickLook && focused?.rel_path ? <QuickLook receipt={focused} onClose={() => setQuickLook(false)} onOpen={open} /> : null}

      {scanState.phase === "running" || scanState.phase === "failed" ? (
        <div className="sheet-backdrop">
          <div className="sheet sheet--wide" role="dialog" aria-modal="true" aria-label={t("review.scanTitle")}>
            <RunProgress
              title={t("review.scanTitle")}
              steps={buildSteps("scan", scanState.events, scanState.phase === "failed" ? "failed" : null, t)}
              running={scanState.phase === "running"}
              cancelling={scanState.phase === "running" && scanState.cancelling}
              onCancel={scan.cancel}
            />
            {scanState.phase === "failed" ? (
              <>
                <div className="banner banner--error" role="alert">
                  <Icon name="warning" size={14} />
                  <span>{friendlyError(scanState.error, t)}</span>
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

      {confirmFinalize ? (
        <FinalizeSheet
          period={periodLabel(period, t)}
          counts={finalizeCounts(data, merged)}
          pending={pending}
          busy={finalizing}
          onCancel={() => setConfirmFinalize(false)}
          onConfirm={runFinalize}
        />
      ) : null}
    </section>
  );
}

/** The save state after the subtitle's status: " · Saving…", " · Saved" or a failure. */
function SaveStatus({ state }: { state: SaveState }) {
  const { t } = useTranslation();
  switch (state.kind) {
    case "saving":
      return <span className="review-save"> · {t("review.saveState.saving")}</span>;
    case "saved":
      return <span className="review-save"> · {t("review.saveState.saved")}</span>;
    case "failed": {
      const detail = t("review.saveState.failedDetail", { message: friendlyError(state.error, t) });
      return (
        <span className="review-save review-save--failed" role="alert" title={detail}>
          {" · "}
          <Icon name="warning" size={11} /> {t("review.saveState.failed")}
          <span className="visually-hidden">: {detail}</span>
        </span>
      );
    }
    case "idle":
    default:
      return null;
  }
}
