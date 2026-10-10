import "./Main.css";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { ErrorState, needsSettings } from "../components/ErrorState";
import { ActionPopUpButton, type PopUpAction } from "../components/PopUpButton";
import { ResizeHandle, useStoredWidth } from "../components/ResizeHandle";
import { Toolbar, ToolbarPortal } from "../components/Toolbar";
import { errorKind } from "../lib/errors";
import { ErrorText } from "../components/ErrorText";
import { useDockProgress } from "../lib/hooks/useDockProgress";
import { useMenu } from "../lib/hooks/useMenu";
import { useAppState } from "../lib/hooks/useAppState";
import { useRun, type RunState } from "../lib/hooks/useRun";
import { useSafeStorage } from "../lib/hooks/useSafeStorage";
import {
  defaultPeriod,
  emptySummary,
  isReviewable,
  mergePeriods,
  newMonthDefault,
  parsePeriodKey,
  periodKey,
  periodLabel,
  runSummaryText,
  statusLine,
  type Period,
} from "../lib/period";
import type { MenuEntry } from "../lib/popUpMenu";
import { isPreview } from "../lib/preview";
import { buildSteps } from "../lib/steps";
import { listPeriods, openReport, openSettings, revealPeriod, setWindowTitle, startReconcile, type PeriodSummary, type Summary } from "../lib/tauri";
import { NewMonthSheet } from "./NewMonthSheet";
import { RerunSheet } from "./RerunSheet";
import { RunProgress } from "./RunProgress";
import { Sidebar, type RunningMonth } from "./Sidebar";
import { Statements, type Statement } from "./Statements";
import { UpdateBanner } from "./UpdateBanner";
import type { RejectKind, ReviewAvailability, ReviewCommands } from "../review/commands";
import { Welcome } from "./Welcome";

const Review = lazy(() => import("../review/Review").then((m) => ({ default: m.Review })));

/** The sidebar's width range and default, in pixels. */
export const SIDEBAR_WIDTH = { min: 180, max: 280, initial: 220 };

type SheetKind = "new-month" | "rerun";

/** The listing with `period` marked as in review after a run produced `summary`. */
function withReviewed(listed: PeriodSummary[], period: Period, summary: Summary): PeriodSummary[] {
  const key = periodKey(period);
  const entry: PeriodSummary = {
    ...emptySummary(period),
    status: "in_review",
    receipts: summary.totalReceipts,
    transactions: summary.totalTransactions,
    pending: summary.review + summary.unmatched,
  };
  return [...listed.filter((p) => periodKey(p) !== key), entry];
}

/** How many receipts have been read while they are being read, otherwise null. */
function runProgress(state: RunState<Summary>): { current: number; total: number } | null {
  if (state.phase !== "running") {
    return null;
  }
  const last = state.events[state.events.length - 1];
  return last?.step === "extracting" ? { current: last.current, total: last.total } : null;
}

/**
 * The main window: a toolbar, the months in a sidebar and the selected month in the detail area,
 * by where the month stands. Before the app is configured it shows the welcome steps instead.
 */
export function Main() {
  const { t, i18n } = useTranslation();
  const { state, error: loadError, replace, reload } = useAppState();
  const fallback = useMemo(() => defaultPeriod(new Date()), []);
  const [storedKey, setStoredKey] = useSafeStorage("main.period", periodKey(fallback));
  const selected = useMemo(() => parsePeriodKey(storedKey) ?? fallback, [storedKey, fallback]);
  const key = periodKey(selected);
  const [sidebarSetting, setSidebarSetting] = useSafeStorage("main.sidebar", "shown");
  const [sidebarWidth, setSidebarWidth] = useStoredWidth("main.sidebarWidth", SIDEBAR_WIDTH.initial, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max);
  const [listed, setListed] = useState<PeriodSummary[] | null>(null);
  const [listError, setListError] = useState<unknown>(null);
  const [created, setCreated] = useState<Period[]>([]);
  const [statements, setStatements] = useState<Record<string, Statement[]>>({});
  const [runPeriod, setRunPeriod] = useState<Period | null>(null);
  /** Whether the last run read every receipt again, so Try Again repeats it the same way. */
  const lastClearCache = useRef(false);
  const [lastRun, setLastRun] = useState<{ key: string; summary: Summary } | null>(null);
  const [message, setMessage] = useState<unknown>(null);
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [subtitleSlot, setSubtitleSlot] = useState<HTMLElement | null>(null);
  const [trailingSlot, setTrailingSlot] = useState<HTMLElement | null>(null);
  /** The open review's commands, for the app menu. */
  const reviewCommands = useRef<ReviewCommands>(null);
  const [reviewCan, setReviewCan] = useState<ReviewAvailability | null>(null);
  const [inspectorShown, setInspectorShown] = useState(true);
  const [rejectKind, setRejectKind] = useState<RejectKind>("removeMatch");
  /** The statements area's file picker, for the app menu. */
  const statementsPicker = useRef<{ browse: () => void }>(null);
  const run = useRun<Summary>();
  useDockProgress(run.state);

  const configured = state?.configured === true;
  const root = state?.settings.receipts_root ?? null;
  const sidebarShown = sidebarSetting !== "hidden";

  /** Counts listings, so only the latest one lands. */
  const listing = useRef(0);
  const refresh = useCallback(() => {
    listing.current += 1;
    const mine = listing.current;
    listPeriods().then(
      (list) => {
        if (listing.current === mine) {
          setListed(list);
          setListError(null);
        }
      },
      (e) => {
        if (listing.current === mine) {
          setListError(e);
        }
      },
    );
  }, []);

  useEffect(() => {
    if (!configured) {
      return;
    }
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [configured, root, refresh]);

  const periods = useMemo(() => mergePeriods(listed ?? [], [fallback, selected, ...created]), [listed, fallback, selected, created]);
  const summary = periods.find((p) => periodKey(p) === key) ?? emptySummary(selected);
  const label = periodLabel(selected, t);

  const windowTitle = configured ? label : "Concilia";
  useEffect(() => {
    document.title = windowTitle;
    if (!isPreview()) {
      setWindowTitle(windowTitle).catch((e) => console.error("could not set the window title", e));
    }
  }, [windowTitle]);

  const select = useCallback(
    (period: Period) => {
      setStoredKey(periodKey(period));
      setMessage(null);
      setLastRun(null);
    },
    [setStoredKey],
  );

  function reconcile(clearCache: boolean) {
    const target = selected;
    const files = (statements[periodKey(target)] ?? []).map(({ path, bank }) => ({ path, bank }));
    setSheet(null);
    setMessage(null);
    setLastRun(null);
    setRunPeriod(target);
    lastClearCache.current = clearCache;
    run.start((onEvent) => startReconcile(target.year, target.month, files, clearCache, onEvent));
  }

  const { state: runState, reset: resetRun } = run;
  useEffect(() => {
    if (runState.phase !== "succeeded" || !runPeriod) {
      return;
    }
    const done = periodKey(runPeriod);
    const result = runState.result;
    setListed((prev) => withReviewed(prev ?? [], runPeriod, result));
    setStatements((prev) => {
      const next = { ...prev };
      delete next[done];
      return next;
    });
    setStoredKey(done);
    setLastRun({ key: done, summary: result });
    setRunPeriod(null);
    resetRun();
    refresh();
  }, [runState, runPeriod, resetRun, refresh, setStoredKey]);

  function backToStatements() {
    resetRun();
    setRunPeriod(null);
  }

  const showSettings = () => {
    openSettings().catch(setMessage);
  };

  const revealMonth = (period: Period) => {
    revealPeriod(period.year, period.month).catch(setMessage);
  };
  const reveal = () => revealMonth(selected);
  const runHere = runPeriod !== null && periodKey(runPeriod) === key && runState.phase !== "idle";
  const running = runState.phase === "running";
  const monthStatements = statements[key] ?? [];
  const runningMonth: RunningMonth | null = runPeriod && running ? { key: periodKey(runPeriod), progress: runProgress(runState) } : null;
  const listReady = listed !== null || listError !== null;
  const existingKeys = useMemo(() => new Set(periods.map(periodKey)), [periods]);
  const reviewable = isReviewable(summary);

  const onStatementsScreen = Boolean(state?.configured) && listReady && !runHere && !reviewable;
  const reviewShown = Boolean(state?.configured) && listReady && !runHere && reviewable;
  useMenu(
    {
      configured,
      sidebarShown,
      inspectorShown,
      rejectKind,
      acceptsStatements: onStatementsScreen && !running,
      canReconcile: monthStatements.length > 0 || summary.transactions > 0,
      hasResult: reviewable,
      running,
      reviewCan: reviewShown ? reviewCan : null,
    },
    {
      newMonth: () => setSheet("new-month"),
      addStatements: () => statementsPicker.current?.browse(),
      reconcile: () => reconcile(false),
      rerun: () => setSheet("rerun"),
      openReport: () => {
        openReport(selected.year, selected.month).catch(setMessage);
      },
      revealPeriod: reveal,
      toggleSidebar: () => setSidebarSetting(sidebarShown ? "hidden" : "shown"),
    },
    reviewCommands,
  );

  /** A month's context menu in the sidebar. */
  function monthMenu(month: PeriodSummary): MenuEntry[] {
    const entries: MenuEntry[] = [{ label: t("month.showInFinder"), onSelect: () => revealMonth(month) }];
    if (isReviewable(month)) {
      entries.push({ label: t("month.rerun"), onSelect: () => setSheet("rerun"), disabled: running });
    }
    return entries;
  }

  let detail: ReactNode = null;
  let subtitle: ReactNode = null;
  let trailing: ReactNode = null;
  if (state && !state.configured) {
    detail = <Welcome state={state} period={fallback} onState={replace} onError={setMessage} />;
  } else if (state && runHere) {
    const failed = runState.phase === "failed" ? runState.error : null;
    const cancelled = failed !== null && errorKind(failed) === "cancelled";
    const outcome = failed !== null ? "failed" : null;
    const progress = runningMonth?.progress;
    if (failed !== null) {
      subtitle = cancelled ? t("month.status.stopped") : t("month.status.failed");
    } else {
      subtitle = progress ? t("progress.readingCount", progress) : t("month.status.reconciling");
    }
    detail = (
      <div className="run-panel">
        <RunProgress title={t("progress.title", { period: label })} steps={buildSteps("reconcile", runState.events, outcome, t)} />
        {failed !== null ? (
          <>
            <div className={`banner ${cancelled ? "banner--info" : "banner--error"}`} role="alert">
              <Icon name="warning" size={14} />
              <span className="grow">
                <ErrorText error={failed} />
              </span>
            </div>
            <div className="run__actions">
              <button type="button" onClick={backToStatements}>
                {t("month.backToStatements")}
              </button>
              {needsSettings(failed) ? (
                <button type="button" onClick={showSettings}>
                  {t("common.openSettings")}
                </button>
              ) : null}
              <button type="button" className="default" onClick={() => reconcile(lastClearCache.current)}>
                {t("common.tryAgain")}
              </button>
            </div>
          </>
        ) : null}
      </div>
    );
    if (runState.phase === "running") {
      trailing = (
        <button type="button" onClick={run.cancel} disabled={runState.cancelling}>
          {runState.cancelling ? t("progress.cancelling") : t("common.cancel")}
        </button>
      );
    }
  } else if (state && listReady) {
    const status = statusLine(summary, t).label;
    const runSummary = lastRun?.key === key ? runSummaryText(lastRun.summary, i18n.language, t) : undefined;
    const actions: PopUpAction[] = [
      {
        label: t("month.openReport"),
        onSelect: () => {
          openReport(selected.year, selected.month).catch(setMessage);
        },
        disabled: !reviewable,
      },
      { label: t("month.showInFinder"), onSelect: reveal },
    ];
    if (reviewable) {
      actions.push({ label: t("month.rerun"), onSelect: () => setSheet("rerun"), disabled: running });
      // The review fills the toolbar's subtitle and trailing controls itself.
      subtitle = <span ref={setSubtitleSlot} className="titlebar__slot" />;
      trailing = <div ref={setTrailingSlot} className="titlebar__slot" />;
      detail = (
        <Suspense fallback={<ToolbarPortal target={subtitleSlot}>{runSummary ?? status}</ToolbarPortal>}>
          <Review
            key={key}
            ref={reviewCommands}
            period={selected}
            toolbar={{ subtitle: subtitleSlot, trailing: trailingSlot }}
            status={status}
            runSummary={runSummary}
            moreActions={actions}
            onChanged={refresh}
            onError={setMessage}
            onAvailabilityChange={setReviewCan}
            onRejectKindChange={setRejectKind}
            onInspectorChange={setInspectorShown}
          />
        </Suspense>
      );
    } else {
      subtitle = runSummary ?? status;
      trailing = (
        <>
          <div className="toolbar-group">
            <ActionPopUpButton label={t("toolbar.moreActions")} actions={actions} className="toolbar-group__item" borderless />
          </div>
          <button
            type="button"
            className="default"
            disabled={running || (monthStatements.length === 0 && summary.transactions === 0)}
            onClick={() => reconcile(false)}
          >
            {t("month.reconcile")}
          </button>
        </>
      );
      detail = (
        <Statements
          ref={statementsPicker}
          period={selected}
          summary={summary}
          receiptsRoot={root}
          statements={monthStatements}
          onStatements={(next) => setStatements((prev) => ({ ...prev, [key]: next }))}
          onReveal={reveal}
          onError={setMessage}
        />
      );
    }
  }

  const showSidebar = configured && sidebarShown;
  const toggle = configured ? (
    <button
      type="button"
      className="icon titlebar__button"
      aria-label={sidebarShown ? t("toolbar.hideSidebar") : t("toolbar.showSidebar")}
      title={sidebarShown ? t("toolbar.hideSidebar") : t("toolbar.showSidebar")}
      onClick={() => setSidebarSetting(sidebarShown ? "hidden" : "shown")}
    >
      <Icon name="sidebar" size={16} />
    </button>
  ) : null;

  return (
    <div className="main">
      <Toolbar
        leading={toggle}
        leadingWidth={showSidebar ? sidebarWidth : undefined}
        title={configured ? label : undefined}
        subtitle={subtitle}
        trailing={trailing}
        separator={configured}
      />
      <div className="main__body">
        {showSidebar ? (
          <>
            <Sidebar
              periods={periods}
              selected={key}
              onSelect={select}
              running={runningMonth}
              loading={!listReady}
              error={listError}
              onRetry={refresh}
              onNewMonth={() => setSheet("new-month")}
              menu={monthMenu}
              width={sidebarWidth}
            />
            <ResizeHandle
              label={t("sidebar.resize")}
              width={sidebarWidth}
              min={SIDEBAR_WIDTH.min}
              max={SIDEBAR_WIDTH.max}
              grows="right"
              onResize={setSidebarWidth}
            />
          </>
        ) : null}
        <main className={`detail ${configured && reviewable && !runHere ? "detail--review" : ""}`}>
          <UpdateBanner onError={setMessage} />
          {loadError ? (
            <ErrorState title={t("main.loadFailed")} error={loadError}>
              {needsSettings(loadError) ? (
                <button type="button" onClick={showSettings}>
                  {t("common.openSettings")}
                </button>
              ) : null}
              <button type="button" className="default" onClick={reload}>
                {t("common.tryAgain")}
              </button>
            </ErrorState>
          ) : null}
          {message !== null ? (
            <div className="banner banner--error" role="alert">
              <Icon name="warning" size={14} />
              <span className="grow">
                <ErrorText error={message} />
              </span>
              <button type="button" className="icon" aria-label={t("common.close")} title={t("common.close")} onClick={() => setMessage(null)}>
                <Icon name="xmark" size={12} />
              </button>
            </div>
          ) : null}
          {detail}
        </main>
      </div>
      {sheet === "new-month" ? (
        <NewMonthSheet
          initial={newMonthDefault(periods, new Date())}
          existing={existingKeys}
          onCancel={() => setSheet(null)}
          onCreate={(period) => {
            setCreated((prev) => [...prev, period]);
            select(period);
            setSheet(null);
          }}
        />
      ) : null}
      {sheet === "rerun" ? <RerunSheet period={label} onCancel={() => setSheet(null)} onConfirm={() => reconcile(true)} /> : null}
    </div>
  );
}
