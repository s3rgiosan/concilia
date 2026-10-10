import "./Review.css";
import { useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { ErrorState, needsSettings } from "../components/ErrorState";
import { Icon, type IconName } from "../components/Icon";
import type { PopUpAction } from "../components/PopUpButton";
import { Presence } from "../components/Presence";
import { ResizeHandle, useStoredWidth } from "../components/ResizeHandle";
import { ToolbarPortal, type ToolbarSlots } from "../components/Toolbar";
import { errorDetail, errorKind, friendlyError } from "../lib/errors";
import { useLatest } from "../lib/hooks/useLatest";
import { useDockProgress } from "../lib/hooks/useDockProgress";
import { useFileDrop } from "../lib/hooks/useFileDrop";
import { useRun } from "../lib/hooks/useRun";
import { useToolbarOverflow } from "../lib/hooks/useToolbarOverflow";
import { periodInSentence, periodLabel, type Period } from "../lib/period";
import { popUpMenu, type MenuEntry } from "../lib/popUpMenu";
import { buildSteps } from "../lib/steps";
import { fileName, isPdf, newStatements, type Statement } from "../main/Statements";
import {
  exportReport,
  finalize,
  getDraft,
  getReview,
  getRules,
  openReceipt,
  openReport,
  openSettings,
  periodStatus,
  pickStatements,
  rescanReceipt,
  rescanReimbursement,
  revealPeriod,
  saveDraft,
  saveRules,
  startAddStatements,
  startScan,
  type AddStatementsResult,
  type DroppedDecision,
  type Draft,
  type ReceiptMeta,
  type ReviewData,
  type RunEvent,
  type RunHandle,
  type ScanResult,
  type Transaction,
} from "../lib/tauri";
import { AddStatementsSheet } from "./AddStatementsSheet";
import type { RejectKind, ReviewAvailability, ReviewCommands } from "./commands";
import { assign, changedIds, confirm, forDraft, noReceipt, patchDraftReceipt, unmatch, type Decision } from "./decisions";
import {
  claimedFiles,
  filterCounts,
  finalizeCounts,
  isNoReceipt,
  mergeDraft,
  patchReceipt,
  pendingCount,
  relPaths,
  unmatchedPool,
  visibleReimbursements,
  visibleTransactions,
  FILTERS,
  NO_RECEIPT_CATEGORIES,
  type Filter,
  type NoReceiptCategory,
} from "./effective";
import { Details, type DetailsHandlers } from "./Details";
import { FinalizeSheet } from "./FinalizeSheet";
import { useHistory } from "./history";
import { QuickLook } from "./QuickLook";
import { receiptTitle } from "./receipts";
import { ReviewToolbar, TOOLBAR_LEVELS, type ToolbarLevel } from "./ReviewToolbar";
import { buildRows, findPending, initialSelection, resolveSelection, rowReceipts, type ListRow } from "./rows";
import { RunSheet } from "./RunSheet";
import { TransactionList } from "./TransactionList";
import { useDraftAutosave, type SaveState } from "./useDraftAutosave";

type Loaded = { data: ReviewData; applied: boolean };

/** The details column's width range and default, in pixels. */
export const DETAILS_WIDTH = { min: 280, max: 420, initial: 300 };

/**
 * The selected row, and where it was in the list, so the row after it takes over if it leaves.
 * A decision on the row sets `advance`, which hands the selection to the next undecided row.
 */
type Selection = { id: string | null; index: number; advance?: boolean };

/** The receipt focused in the details column, for the row it was focused in. */
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
  /** Runs whenever the selected transaction changes what Reject does, such as for the app menu's label. */
  onRejectKindChange?: (kind: RejectKind) => void;
  ref?: Ref<ReviewCommands>;
}

/** A short message over the list, such as a rule that was added or what a scan found. */
type Notice = { tone: "success" | "info"; text: string; icon?: IconName };

/** A run inside the review: a scan for new receipts, or statements being added. */
type JobKind = "scan" | "add";

/** What a scan or added statements changed: decisions dropped, and the line that sums it up. */
type JobOutcome = { dropped: DroppedDecision[]; notice: Notice };

/** The statements chosen in the Add Statements sheet, and a file it turned away. */
type Adding = { files: Statement[]; rejected: string | null };

/** "3 new receipts · 1 matched", or that the scan found nothing new. */
export function scanNotice(result: ScanResult, t: TFunction): Notice {
  if (result.new_receipts === 0 && result.newly_matched === 0) {
    return { tone: "info", text: t("review.result.noNewReceipts"), icon: "scan" };
  }
  const parts = [t("review.result.newReceipts", { count: result.new_receipts })];
  if (result.newly_matched > 0) {
    parts.push(t("review.result.matched", { count: result.newly_matched }));
  }
  return { tone: "success", text: parts.join(" · ") };
}

/** "3 transactions added · 1 duplicate skipped · 2 matched". */
export function addNotice(result: AddStatementsResult, t: TFunction): Notice {
  const parts = [t("review.result.added", { count: result.added })];
  if (result.duplicates_skipped > 0) {
    parts.push(t("review.result.skipped", { count: result.duplicates_skipped }));
  }
  if (result.newly_matched > 0) {
    parts.push(t("review.result.matched", { count: result.newly_matched }));
  }
  return result.added > 0 ? { tone: "success", text: parts.join(" · ") } : { tone: "info", text: parts.join(" · "), icon: "doc" };
}

/** A run whose result is summed up as a `JobOutcome` once it ends. */
function withOutcome<T>(handle: RunHandle<T>, outcome: (result: T) => JobOutcome): RunHandle<JobOutcome> {
  return { ...handle, promise: handle.promise.then(outcome) };
}

/**
 * The review of a month's matches: a list of transactions beside the details of the selected
 * one. It opens on the transactions still to decide when there are any. Decisions save as a draft
 * until Finalize applies them, and each can be undone.
 */
export function Review({ period, toolbar, status, runSummary, moreActions, onChanged, onError, onAvailabilityChange, onRejectKindChange, ref }: ReviewProps) {
  const { t, i18n } = useTranslation();
  const { year, month } = period;
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const history = useHistory<Draft>({});
  const [dirty, setDirty] = useState(false);
  const [filter, setFilterState] = useState<Filter>("all");
  /** Whether the filter was set for the month, once its first load showed what is left to decide. */
  const filterSet = useRef(false);
  const [search, setSearchState] = useState("");
  const [selection, setSelection] = useState<Selection>({ id: null, index: 0 });
  const [focus, setFocus] = useState<Focus>(null);
  const [quickLook, setQuickLook] = useState(false);
  const [rescanning, setRescanning] = useState<Set<string>>(new Set());
  const [dropped, setDropped] = useState<DroppedDecision[]>([]);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  /** Finalize succeeded while the review was open, so the completion banner shows. */
  const [justFinalized, setJustFinalized] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [detailsWidth, setDetailsWidth] = useStoredWidth("review.detailsWidth", DETAILS_WIDTH.initial, DETAILS_WIDTH.min, DETAILS_WIDTH.max);
  const job = useRun<JobOutcome>();
  const [jobKind, setJobKind] = useState<JobKind>("scan");
  /** Starts the last run again, for Try Again. */
  const lastJob = useRef<(() => void) | null>(null);
  const [adding, setAdding] = useState<Adding | null>(null);
  useDockProgress(job.state);

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
        if (!filterSet.current) {
          filterSet.current = true;
          const open = pendingCount(mergeDraft(data.transactions, stored));
          setFilterState(open > 0 && !periodState.applied ? "pending" : "all");
        }
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
  const edited = useMemo(() => new Set(Object.keys(draft)), [draft]);

  const selected = selection.id === null ? initialSelection(rows) : resolveSelection(rows, selection.id, selection.index, selection.advance);
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

  const jobRunning = job.state.phase === "running";
  const busy = finalizing || jobRunning;
  const ready = loaded !== null;
  /** Decisions can change: the month is not finalized and nothing else runs. */
  const decidable = !busy && !applied;

  const contentKey = `${i18n.language}|${applied}|${FILTERS.map((f) => counts[f]).join(",")}`;
  const toolbarLevel = useToolbarOverflow(toolbar.trailing, TOOLBAR_LEVELS, contentKey) as ToolbarLevel;

  const nextPendingIndex = findPending(rows, selectedIndex, 1);
  const previousPendingIndex = findPending(rows, selectedIndex < 0 ? rows.length : selectedIndex, -1);
  const can: ReviewAvailability = {
    accept: selectedTx !== null && selectedTx.status !== "MATCHED" && focused !== null && decidable,
    reject: selectedTx !== null && selectedTx.status !== "UNMATCHED" && decidable,
    noReceipt: selectedTx !== null && selectedTx.status !== "MATCHED" && decidable,
    rescan: Boolean(focused?.rel_path) && !rescanning.has(focused?.file ?? "") && !applied,
    quickLook: quickLook || Boolean(focused?.rel_path),
    openInPreview: Boolean(focused?.rel_path),
    nextPending: nextPendingIndex >= 0,
    previousPending: previousPendingIndex >= 0,
    undo: history.canUndo && decidable,
    redo: history.canRedo && decidable,
    setFilter: ready,
    focusSearch: ready,
    scan: ready && !busy && !applied,
    exportReport: ready && !busy,
    finalize: ready && !busy && !applied,
    addStatements: ready && !busy && !applied,
  };

  function selectRow(row: ListRow) {
    setSelection({ id: row.id, index: rows.indexOf(row) });
  }

  /** Records a decision. If the row then leaves the list, the next undecided row is selected. */
  function decide(tx: Transaction, decision: Decision) {
    history.record((prev) => ({ ...prev, [tx.id]: forDraft(decision) }));
    setDirty(true);
    setSelection((prev) => (prev.id === tx.id ? { ...prev, advance: true } : prev));
  }

  /** Accepts a REVIEW candidate, or assigns a pool receipt to an UNMATCHED transaction. */
  function acceptReceipt(tx: Transaction, receipt: ReceiptMeta) {
    decide(tx, tx.status === "REVIEW" ? confirm(tx, receipt) : assign(receipt));
  }

  /** Steps through the history and selects the transaction whose decision changed. */
  function step(direction: "undo" | "redo") {
    const other = direction === "undo" ? history.previous : history.next;
    if (other === undefined || !decidable) {
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
    if (!receipt.rel_path || rescanning.has(receipt.file) || applied) {
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

  /** Saves pending decisions, then starts a run; Try Again starts it the same way. */
  function runJob(kind: JobKind, launch: (onEvent: (event: RunEvent) => void) => RunHandle<JobOutcome>) {
    setDropped([]);
    setNotice(null);
    setJobKind(kind);
    lastJob.current = () => runJob(kind, launch);
    autosave
      .flush()
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

  /** Adds picked or dropped files to the Add Statements sheet, opening it when it is closed. */
  function addFiles(paths: string[]) {
    const pdfs = paths.filter(isPdf);
    const firstRejected = paths.find((p) => !isPdf(p));
    setAdding((prev) => {
      const files = prev?.files ?? [];
      return { files: [...files, ...newStatements(pdfs, files)], rejected: firstRejected === undefined ? null : fileName(firstRejected) };
    });
  }

  function chooseStatements() {
    pickStatements().then((paths) => {
      if (paths.length > 0) {
        addFiles(paths);
      }
    }, onError);
  }

  const dragging = useFileDrop(addFiles, can.addStatements && !confirmFinalize && !quickLook);

  const { state: jobState, reset: resetJob } = job;
  useEffect(() => {
    if (jobState.phase === "succeeded") {
      setDropped(jobState.result.dropped);
      setNotice(jobState.result.notice);
      setAdding(null);
      resetJob();
      load();
      onChanged?.();
    } else if (jobState.phase === "failed" && errorKind(jobState.error) === "cancelled") {
      // A run the user stopped closes its sheet, back to the chosen statements when adding.
      resetJob();
    }
  }, [jobState, resetJob, load, onChanged]);

  /** Closes a failed run's sheet and drops the statements it was adding. */
  function closeJob() {
    resetJob();
    setAdding(null);
  }

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
        setJustFinalized(true);
        setNotice(null);
        load();
        onChanged?.();
      })
      .catch(onError)
      .finally(() => setFinalizing(false));
  }

  function setFilter(next: Filter) {
    setFilterState(next);
    setSelection((prev) => ({ id: prev.id, index: 0 }));
  }

  function setSearch(next: string) {
    setSearchState(next);
    setSelection((prev) => ({ id: prev.id, index: 0 }));
  }

  function focusList() {
    listRef.current?.focus();
  }

  /** Moves focus to the details column's first decision control, so Return there commits it. */
  function focusDetailsAction() {
    const first = sectionRef.current?.querySelector(".details [data-details-action]");
    const target = first instanceof HTMLButtonElement ? first : first?.querySelector("button");
    target?.focus();
  }

  /** Moves the selection one row, keeping it within the list. */
  function moveSelection(direction: 1 | -1) {
    const target = rows[Math.min(Math.max(selectedIndex + direction, 0), rows.length - 1)];
    if (target) {
      selectRow(target);
    }
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
    addStatements: () => {
      if (can.addStatements) {
        chooseStatements();
      }
    },
    can,
  };

  useImperativeHandle(ref, () => commands);

  // Runs after the closing sheet hands focus back, so the list keeps it.
  const focusListAfterSheet = useRef(false);
  useEffect(() => {
    if (!confirmFinalize && focusListAfterSheet.current) {
      focusListAfterSheet.current = false;
      listRef.current?.focus();
    }
  }, [confirmFinalize]);

  const canKey = JSON.stringify(can);
  const reportAvailability = useLatest(onAvailabilityChange);
  useEffect(() => {
    reportAvailability.current?.(JSON.parse(canKey) as ReviewAvailability);
  }, [canKey, reportAvailability]);

  const rejectKind = rejectKindOf(selectedTx);
  const reportRejectKind = useLatest(onRejectKindChange);
  useEffect(() => {
    reportRejectKind.current?.(rejectKind);
  }, [rejectKind, reportRejectKind]);

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
        focusDetailsAction();
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
        <ErrorState title={t("review.loadFailed")} error={loadError}>
          {needsSettings(loadError) ? (
            <button type="button" onClick={() => openSettings().catch(onError)}>
              {t("common.openSettings")}
            </button>
          ) : null}
          <button type="button" className="default" onClick={load}>
            {t("common.tryAgain")}
          </button>
        </ErrorState>
      </section>
    );
  }
  if (!loaded || !data) {
    return subtitle;
  }

  /** Runs a decision made in the details column, then returns focus to the list. */
  function fromDetails(run: () => void) {
    run();
    focusList();
  }

  const handlers: DetailsHandlers = {
    onFocusReceipt: (receipt) => {
      if (selected) {
        setFocus({ rowId: selected.id, file: receipt.file });
      }
    },
    onAccept: (receipt) =>
      fromDetails(() => {
        if (selectedTx && decidable) {
          acceptReceipt(selectedTx, receipt);
        }
      }),
    onReject: () => fromDetails(commands.reject),
    onNoReceipt: (category) => fromDetails(() => commands.noReceipt(category)),
    onRescan: (receipt) => {
      void rescan(receipt, selected?.kind === "reimbursement");
    },
    onOpen: open,
    onQuickLook: () => setQuickLook(true),
  };

  /** Adds a match rule from a decision: the receipt's vendor to the transaction's description. */
  function addRule(vendor: string, description: string) {
    getRules()
      .then((rules) => {
        const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
        const exists = rules.some((r) => same(r.receiptVendor, vendor) && same(r.transactionDescription, description));
        if (exists) {
          setNotice({ tone: "info", text: t("review.rule.exists") });
          return;
        }
        const rule = { id: crypto.randomUUID(), receiptVendor: vendor, transactionDescription: description };
        return saveRules([...rules, rule]).then(() => setNotice({ tone: "success", text: t("review.rule.added") }));
      })
      .catch(onError);
  }

  /** Always Match for a transaction the user matched to a receipt with a vendor, or null. */
  function ruleEntry(tx: Transaction): MenuEntry | null {
    const vendor = tx.receipt_meta[0]?.vendor?.trim();
    if (!edited.has(tx.id) || tx.status !== "MATCHED" || isNoReceipt(tx.notes) || !vendor) {
      return null;
    }
    return { label: t("review.rule.alwaysMatch", { vendor, description: tx.description }), onSelect: () => addRule(vendor, tx.description) };
  }

  /** The commands of a row's context menu, for that row and the receipt it shows. */
  function rowMenu(row: ListRow): MenuEntry[] {
    const isSelected = row.id === selected?.id;
    const shown = isSelected ? focused : (rowReceipts(row, pool, claimed)[0] ?? null);
    const look: MenuEntry[] = [
      {
        label: t("menu.quick_look"),
        onSelect: () => {
          selectRow(row);
          setQuickLook(true);
        },
        disabled: !shown?.rel_path,
      },
      { label: t("menu.open_in_preview"), onSelect: () => shown && open(shown), disabled: !shown?.rel_path },
    ];
    if (row.kind === "reimbursement") {
      return [
        { label: t("menu.rescan"), onSelect: () => void rescan(row.receipt, true), disabled: applied || !row.receipt.rel_path || rescanning.has(row.receipt.file) },
        "separator",
        ...look,
      ];
    }
    const { tx } = row;
    const rule = applied ? null : ruleEntry(tx);
    return [
      { label: t("menu.accept"), onSelect: () => shown && acceptReceipt(tx, shown), disabled: !decidable || tx.status === "MATCHED" || !shown },
      {
        label: t(rejectMenuLabel(rejectKindOf(tx))),
        onSelect: () => decide(tx, unmatch()),
        disabled: !decidable || tx.status === "UNMATCHED",
      },
      {
        label: t("menu.no_receipt"),
        disabled: !decidable || tx.status === "MATCHED",
        submenu: NO_RECEIPT_CATEGORIES.map((category) => ({ label: t(`menu.no_receipt_${category}`), onSelect: () => decide(tx, noReceipt(category)) })),
      },
      ...(rule ? (["separator", rule] as MenuEntry[]) : []),
      "separator",
      ...look,
    ];
  }

  function showRowMenu(row: ListRow, e: MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    selectRow(row);
    focusList();
    void popUpMenu(rowMenu(row), { x: e.clientX, y: e.clientY });
  }

  /** Closes the Finalize sheet and goes to the first transaction still to decide. */
  function reviewRemaining() {
    focusListAfterSheet.current = true;
    setConfirmFinalize(false);
    setSearchState("");
    setFilterState("pending");
    setSelection({ id: null, index: 0 });
  }

  /** The list's message when it shows no rows, with the step that leads on. */
  function emptyList(): ReactNode {
    const query = search.trim();
    if (query) {
      return <p className="review__empty-title">{t("review.noResults", { query })}</p>;
    }
    if (filter === "pending" && pending === 0) {
      return (
        <>
          <p className="review__empty-title">{t("review.empty.doneTitle")}</p>
          {applied ? null : (
            <>
              <p className="review__empty-message">{t("review.empty.doneMessage")}</p>
              <button type="button" className="default" onClick={commands.finalize} disabled={!can.finalize}>
                {t("review.finalize")}
              </button>
            </>
          )}
        </>
      );
    }
    if (filter !== "pending" && pending > 0) {
      return (
        <>
          <p className="review__empty-title">{t(`review.empty.none_${filter}`)}</p>
          <p className="review__empty-message">{t("review.empty.pendingMessage", { count: pending })}</p>
          <button type="button" onClick={() => setFilter("pending")}>
            {t("review.empty.showThem")}
          </button>
        </>
      );
    }
    return <p className="review__empty-title">{t(`review.empty.none_${filter}`)}</p>;
  }

  return (
    <section
      ref={sectionRef}
      className="review"
      style={{ "--details-width": `${detailsWidth}px` } as CSSProperties}
      aria-label={t("review.title", { period: periodLabel(period, t) })}>
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
          onClearSearch={() => {
            setSearch("");
            searchRef.current?.focus();
          }}
          busy={busy}
          finalized={applied}
          moreActions={moreActions}
          onScan={commands.scan}
          onAddStatements={commands.addStatements}
          onExport={commands.exportReport}
          onFinalize={commands.finalize}
          onOpenReport={() => {
            openReport(year, month).catch(onError);
          }}
          level={toolbarLevel}
        />
      </ToolbarPortal>

      <div className="review__main">
        {applied && justFinalized ? (
          <div className="banner banner--success review__banner" role="status">
            <Icon name="check" size={14} className="banner__icon--success" />
            <span className="grow">{t("review.finalizedBanner", { period: periodLabel(period, t) })}</span>
            <button type="button" className="banner__action" onClick={() => revealPeriod(year, month).catch(onError)}>
              {t("month.showInFinder")}
            </button>
            <button type="button" className="banner__action" onClick={() => openReport(year, month).catch(onError)}>
              {t("month.openReport")}
            </button>
            <button type="button" className="icon" aria-label={t("common.dismiss")} title={t("common.dismiss")} onClick={() => setJustFinalized(false)}>
              <Icon name="xmark" size={12} />
            </button>
          </div>
        ) : null}
        {notice ? (
          <div className={`banner ${notice.tone === "success" ? "banner--success" : "banner--info"} review__banner`} role="status">
            <Icon name={notice.icon ?? (notice.tone === "success" ? "check" : "rules")} size={14} className={notice.tone === "success" ? "banner__icon--success" : undefined} />
            <span className="grow">{notice.text}</span>
            <button type="button" className="icon" aria-label={t("common.dismiss")} title={t("common.dismiss")} onClick={() => setNotice(null)}>
              <Icon name="xmark" size={12} />
            </button>
          </div>
        ) : null}
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
            viewKey={`${filter}|${search}`}
            selectedId={selected?.id ?? null}
            edited={edited}
            reimbursementTotal={reimbursementTotal}
            listRef={listRef}
            onSelect={selectRow}
            onOpen={(row) => {
              selectRow(row);
              setQuickLook(true);
            }}
            onContextMenu={showRowMenu}
            onKeyDown={onListKeyDown}
          />
          {rows.length === 0 ? <div className="review__empty">{emptyList()}</div> : null}
        </div>
      </div>

      <ResizeHandle
        label={t("review.resizeDetails")}
        width={detailsWidth}
        min={DETAILS_WIDTH.min}
        max={DETAILS_WIDTH.max}
        grows="left"
        scope={sectionRef}
        variable="--details-width"
        onResize={setDetailsWidth}
      />
      <Details
        row={selected}
        receipts={receipts}
        focused={focused}
        rescanning={rescanning}
        readOnly={applied}
        edited={selectedTx !== null && edited.has(selectedTx.id)}
        handlers={handlers}
      />

      <Presence>
        {quickLook && selected ? (
          <QuickLook
            receipt={focused}
            name={selected.kind === "transaction" ? selected.tx.description : receiptTitle(selected.receipt)}
            onClose={() => setQuickLook(false)}
            onOpen={open}
            onMove={moveSelection}
          />
        ) : null}
      </Presence>

      {dragging && adding === null ? (
        <div className="review__drop" aria-hidden="true">
          <Icon name="drop" size={36} />
          <p>{t("review.addStatements.drop", { period: periodInSentence(period, t, i18n.language) })}</p>
        </div>
      ) : null}

      <Presence>
        {jobState.phase === "running" || jobState.phase === "failed" ? (
          <RunSheet
            title={jobKind === "scan" ? t("review.scan") : t("review.addStatements.running")}
            steps={buildSteps(jobKind, jobState.events, jobState.phase === "failed" ? "failed" : null, t)}
            running={jobState.phase === "running"}
            cancelling={jobState.phase === "running" && jobState.cancelling}
            error={jobState.phase === "failed" ? jobState.error : null}
            onCancel={job.cancel}
            onClose={closeJob}
            onRetry={() => lastJob.current?.()}
            onOpenSettings={() => openSettings().catch(onError)}
          />
        ) : adding ? (
          <AddStatementsSheet
            period={periodInSentence(period, t, i18n.language)}
            existing={data.statements ?? []}
            files={adding.files}
            rejected={adding.rejected}
            onFiles={(files) => setAdding({ files, rejected: null })}
            onChoose={chooseStatements}
            onCancel={() => setAdding(null)}
            onAdd={() => startAdding(adding.files)}
          />
        ) : null}
      </Presence>

      <Presence>
        {confirmFinalize ? (
          <FinalizeSheet
            period={periodLabel(period, t)}
            counts={finalizeCounts(data, merged)}
            pending={pending}
            busy={finalizing}
            onCancel={() => setConfirmFinalize(false)}
            onConfirm={runFinalize}
            onReviewRemaining={reviewRemaining}
          />
        ) : null}
      </Presence>
    </section>
  );
}

/** What Reject does for a transaction, which names its menu item and button. */
export function rejectKindOf(tx: Transaction | null): RejectKind {
  if (tx?.status === "REVIEW") {
    return "noneOfThese";
  }
  if (tx && isNoReceipt(tx.notes)) {
    return "needsReceipt";
  }
  return "removeMatch";
}

/** The menu label key of Reject for what it does. */
function rejectMenuLabel(kind: RejectKind): string {
  switch (kind) {
    case "noneOfThese":
      return "menu.reject_review";
    case "needsReceipt":
      return "menu.reject_no_receipt";
    case "removeMatch":
    default:
      return "menu.reject";
  }
}

/** The save state after the subtitle's status: " · Saving…", " · Saved" or a failure. */
function SaveStatus({ state }: { state: SaveState }) {
  const { t } = useTranslation();
  switch (state.kind) {
    case "saving":
      return (
        <span className="review-save">
          <span aria-hidden="true"> · </span>
          {t("review.saveState.saving")}
        </span>
      );
    case "saved":
      return (
        <span className="review-save">
          <span aria-hidden="true"> · </span>
          {t("review.saveState.saved")}
        </span>
      );
    case "failed": {
      const detail = errorDetail(state.error);
      const reason = [friendlyError(state.error, t), detail ? t("errors.details", { detail }) : null].filter(Boolean).join(" ");
      return (
        <span className="review-save review-save--failed" role="alert" title={reason}>
          <span aria-hidden="true"> · </span>
          <Icon name="warning" size={11} /> {t("review.saveState.failed")}
          <span className="visually-hidden">: {reason}</span>
        </span>
      );
    }
    case "idle":
    default:
      return null;
  }
}
