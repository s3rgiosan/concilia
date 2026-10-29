import "./Review.css";
import { useEffect, useId, useImperativeHandle, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, needsSettings } from "../components/ErrorState";
import { Icon } from "../components/Icon";
import type { PopUpAction } from "../components/PopUpButton";
import { Presence } from "../components/Presence";
import { ResizeHandle, useStoredWidth } from "../components/ResizeHandle";
import { ToolbarPortal, type ToolbarSlots } from "../components/Toolbar";
import { useFileDrop } from "../lib/hooks/useFileDrop";
import { useLatest } from "../lib/hooks/useLatest";
import { useShallowStable } from "../lib/hooks/useShallowStable";
import { useStableCallback, useStableHandlers } from "../lib/hooks/useStableCallback";
import { useToolbarOverflow } from "../lib/hooks/useToolbarOverflow";
import { guardCommands, type RejectKind, type ReviewAvailability, type ReviewCommands } from "../lib/menuCommands";
import { fileName } from "../lib/paths";
import { periodInSentence, periodLabel, type Period } from "../lib/period";
import { popUpMenu } from "../lib/popUpMenu";
import { isPdf, newStatements } from "../lib/statements";
import { exportReport, finalize, openReceipt, openReport, openSettings, pickStatements, showAlert, type ReceiptMeta, type Transaction } from "../lib/tauri";
import { rejectKindOf } from "./commands";
import { assign, changedIds, confirm, forDraft, noReceipt, unmatch, type Decision } from "./decisions";
import { finalizeCounts, FILTERS } from "./effective";
import { Details, type DetailsHandlers } from "./Details";
import { finalizeAlert } from "./finalizeAlert";
import { JobSheets, type Adding } from "./JobSheets";
import type { Notice } from "./notices";
import { QuickLook } from "./QuickLook";
import { receiptTitle } from "./receipts";
import { ReviewBanners } from "./ReviewBanners";
import { ReviewEmpty } from "./ReviewEmpty";
import { ReviewToolbar, TOOLBAR_LEVELS } from "./ReviewToolbar";
import { listNavigationTarget, type ListRow } from "./rows";
import { rowMenu, type RowMenuContext } from "./rowMenu";
import { SaveStatus } from "./SaveStatus";
import { TransactionList } from "./TransactionList";
import { useReviewData } from "./useReviewData";
import { useReviewList } from "./useReviewList";
import { useReviewJobs } from "./useReviewJobs";

/** The details column's width range and default, in pixels. */
const DETAILS_WIDTH = { min: 280, max: 420, initial: 300 };

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
  /** Runs after the draft is saved, which changes only the month's own summary. */
  onSaved?: (period: Period) => void;
  onError: (e: unknown) => void;
  /** Runs whenever the commands that can run change, such as for the app menu. */
  onAvailabilityChange?: (can: ReviewAvailability) => void;
  /** Runs whenever the selected transaction changes what Reject does, such as for the app menu's label. */
  onRejectKindChange?: (kind: RejectKind) => void;
  ref?: Ref<ReviewCommands>;
}

/**
 * The review of a month's matches: a list of transactions beside the details of the selected
 * one. It opens on the transactions still to decide when there are any. Decisions save as a draft
 * until Finalize applies them, and each can be undone.
 */
export function Review({ period, toolbar, status, runSummary, moreActions, onChanged, onSaved, onError, onAvailabilityChange, onRejectKindChange, ref }: ReviewProps) {
  const { t, i18n } = useTranslation();
  const { year, month } = period;
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [quickLook, setQuickLook] = useState(false);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  /** Finalize succeeded while the review was open, so the completion banner shows. */
  const [justFinalized, setJustFinalized] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [detailsWidth, setDetailsWidth] = useStoredWidth("review.detailsWidth", DETAILS_WIDTH.initial, DETAILS_WIDTH.min, DETAILS_WIDTH.max);
  const [adding, setAdding] = useState<Adding | null>(null);
  /** The refused files whose banner was dismissed; a different set shows it again. */
  const [dismissedRefused, setDismissedRefused] = useState("");

  const { data, applied, ready, loadError, load, history, draft, setDirty, autosave, rescanning, rescan } = useReviewData({
    year,
    month,
    onSaved: () => onSaved?.(period),
    onError,
    onFirstLoad: (initial) => list.setFilterState(initial),
  });
  const { job, jobKind, dropped, setDropped, startScanning, startAdding, retry, closeJob } = useReviewJobs({
    year,
    month,
    flush: autosave.flush,
    load,
    onChanged,
    onError,
    setNotice,
    clearAdding: () => setAdding(null),
  });
  const jobState = job.state;
  const refused = data?.refused_files ?? [];
  const refusedKey = refused.map((f) => `${f.file}:${f.code}`).join("|");

  const list = useReviewList(data, draft);
  const { filter, search, merged, claimed, pool, counts, pending, rows, reimbursementTotal, edited, selected, selectedIndex, selectedTx, receipts, focused } = list;
  const { nextPendingIndex, previousPendingIndex, setFilter, setSearch, setSelection, setFocus } = list;

  const busy = finalizing || jobState.phase === "running";
  /** Decisions can change: the month is not finalized and nothing else runs. */
  const decidable = !busy && !applied;

  const contentKey = `${i18n.language}|${applied}|${FILTERS.map((f) => counts[f]).join(",")}`;
  const toolbarLevel = useToolbarOverflow(toolbar.trailing, TOOLBAR_LEVELS, contentKey);

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

  function open(receipt: ReceiptMeta) {
    if (receipt.rel_path) {
      openReceipt(year, month, receipt.rel_path).catch(onError);
    }
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

  function saveReport() {
    autosave
      .flush()
      .then(() => exportReport(year, month))
      .catch(onError);
  }

  /**
   * Confirms Finalize in a native alert. While it shows, dropped files are refused; Review
   * Remaining goes to the first transaction still to decide.
   */
  function askFinalize() {
    if (!data || confirmFinalize) {
      return;
    }
    setConfirmFinalize(true);
    const request = finalizeAlert(
      { period: periodLabel(period, t), counts: finalizeCounts(data, merged), pending, refused: refused.length },
      t,
      i18n.language,
    );
    showAlert(request).then(
      (choice) => {
        switch (choice) {
          case "confirm":
            runFinalize();
            break;
          case "alternate":
            reviewRemaining();
            break;
          default:
            setConfirmFinalize(false);
            break;
        }
      },
      (e) => {
        setConfirmFinalize(false);
        onError(e);
      },
    );
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
      .finally(() => {
        setFinalizing(false);
        setConfirmFinalize(false);
      });
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

  const commands = guardCommands(can, {
    accept: () => {
      if (selectedTx && focused) {
        acceptReceipt(selectedTx, focused);
      }
    },
    reject: () => {
      if (selectedTx) {
        decide(selectedTx, unmatch());
      }
    },
    noReceipt: (category) => {
      if (selectedTx) {
        decide(selectedTx, noReceipt(category));
      }
    },
    rescan: () => {
      if (focused && selected) {
        void rescan(focused, selected.kind === "reimbursement");
      }
    },
    quickLook: () => setQuickLook((shown) => !shown),
    openInPreview: () => {
      if (focused) {
        open(focused);
      }
    },
    nextPending: () => jumpPending(1),
    previousPending: () => jumpPending(-1),
    undo: () => step("undo"),
    redo: () => step("redo"),
    setFilter,
    focusSearch: () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    },
    scan: startScanning,
    exportReport: saveReport,
    finalize: askFinalize,
    addStatements: chooseStatements,
  });

  useImperativeHandle(ref, () => commands);

  // Runs after the Finalize alert closes, so the list takes focus.
  const focusListAfterSheet = useRef(false);
  useEffect(() => {
    if (!confirmFinalize && focusListAfterSheet.current) {
      focusListAfterSheet.current = false;
      listRef.current?.focus();
    }
  }, [confirmFinalize]);

  const stableCan = useShallowStable(can);
  const reportAvailability = useLatest(onAvailabilityChange);
  useEffect(() => {
    reportAvailability.current?.(stableCan);
  }, [stableCan, reportAvailability]);

  const rejectKind = rejectKindOf(selectedTx);
  const reportRejectKind = useLatest(onRejectKindChange);
  useEffect(() => {
    reportRejectKind.current?.(rejectKind);
  }, [rejectKind, reportRejectKind]);

  function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }
    switch (e.key) {
      case " ":
        e.preventDefault();
        commands.quickLook();
        return;
      case "Enter":
        e.preventDefault();
        focusDetailsAction();
        return;
      default:
        break;
    }
    const target = listNavigationTarget(e.key, selectedIndex, rows.length);
    if (target === null) {
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

  /** Runs a decision made in the details column, then returns focus to the list. */
  function fromDetails(run: () => void) {
    run();
    focusList();
  }

  const detailsHandlers = useStableHandlers<DetailsHandlers>({
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
  });

  const menuContext: RowMenuContext = {
    t,
    applied,
    decidable,
    selectedId: selected?.id ?? null,
    focused,
    pool,
    claimed,
    edited,
    rescanning,
    selectRow,
    showQuickLook: () => setQuickLook(true),
    open,
    rescan: (receipt, reimbursement) => void rescan(receipt, reimbursement),
    acceptReceipt,
    decide,
    setNotice,
    onError,
  };

  const showRowMenu = useStableCallback((row: ListRow, e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    selectRow(row);
    focusList();
    void popUpMenu(rowMenu(row, menuContext), { x: e.clientX, y: e.clientY });
  });

  const selectListRow = useStableCallback(selectRow);
  const openListRow = useStableCallback((row: ListRow) => {
    selectRow(row);
    setQuickLook(true);
  });

  const touched = history.canUndo || history.canRedo || autosave.state.kind !== "idle";
  let statusText = status;
  if (ready) {
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
  if (!data) {
    return subtitle;
  }

  /** Goes to the first transaction still to decide, from the Finalize alert. */
  function reviewRemaining() {
    focusListAfterSheet.current = true;
    setConfirmFinalize(false);
    list.setSearchState("");
    list.setFilterState("pending");
    setSelection({ id: null, index: 0 });
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
        <ReviewBanners
          period={period}
          finalized={applied && justFinalized}
          notice={notice}
          dropped={dropped}
          refused={refusedKey === dismissedRefused ? [] : refused}
          onDismissFinalized={() => setJustFinalized(false)}
          onDismissNotice={() => setNotice(null)}
          onDismissDropped={() => setDropped([])}
          onDismissRefused={() => setDismissedRefused(refusedKey)}
          onError={onError}
        />
        <div className="review__list">
          <TransactionList
            listId={listId}
            rows={rows}
            viewKey={`${filter}|${search}`}
            selectedId={selected?.id ?? null}
            edited={edited}
            reimbursementTotal={reimbursementTotal}
            listRef={listRef}
            onSelect={selectListRow}
            onOpen={openListRow}
            onContextMenu={showRowMenu}
            onKeyDown={onListKeyDown}
          />
          {rows.length === 0 ? (
            <div className="review__empty">
              <ReviewEmpty
                filter={filter}
                search={search}
                pending={pending}
                finalized={applied}
                canFinalize={can.finalize}
                onFinalize={commands.finalize}
                onShowPending={() => setFilter("pending")}
              />
            </div>
          ) : null}
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
        quickLook={quickLook}
        handlers={detailsHandlers}
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

      <JobSheets
        period={periodInSentence(period, t, i18n.language)}
        kind={jobKind}
        state={jobState}
        events={job.events}
        adding={adding}
        existing={data.statements ?? []}
        onCancel={job.cancel}
        onClose={closeJob}
        onRetry={retry}
        onOpenSettings={() => openSettings().catch(onError)}
        onFiles={(files) => setAdding({ files, rejected: null })}
        onChoose={chooseStatements}
        onCancelAdding={() => setAdding(null)}
        onAdd={() => adding && startAdding(adding.files)}
      />

    </section>
  );
}

