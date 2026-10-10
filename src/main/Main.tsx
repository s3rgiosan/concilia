import "./Main.css";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type UIEvent } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { ErrorState, needsSettings } from "../components/ErrorState";
import { ActionPopUpButton, type PopUpAction } from "../components/PopUpButton";
import { Presence } from "../components/Presence";
import { ResizeHandle, useStoredWidth } from "../components/ResizeHandle";
import { Toolbar, ToolbarPortal } from "../components/Toolbar";
import { errorKind } from "../lib/errors";
import { ErrorText } from "../components/ErrorText";
import { remainingText } from "../lib/eta";
import { useDockProgress } from "../lib/hooks/useDockProgress";
import { useExtractionEta } from "../lib/hooks/useExtractionEta";
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
  periodInSentence,
  periodKey,
  periodLabel,
  runSummaryText,
  statusLine,
  type Period,
} from "../lib/period";
import type { MenuEntry } from "../lib/popUpMenu";
import { isPreview } from "../lib/preview";
import { buildSteps } from "../lib/steps";
import {
  createPeriod,
  listPeriods,
  openReport,
  openSettings,
  revealPeriod,
  setWindowTitle,
  startReconcile,
  type PeriodSummary,
  type Summary,
} from "../lib/tauri";
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

/** How long the confirmation after setup shows, in milliseconds. */
const SET_UP_NOTICE_MS = 6000;

/** Below this window width the sidebar hides, and showing it lays it over the content. */
export const COMPACT_WIDTH = 1100;

function isCompact(): boolean {
  return window.innerWidth < COMPACT_WIDTH;
}

type SheetKind = "new-month" | "rerun";

/** The listing with `summary` in place of the month's entry. */
function withSummary(listed: PeriodSummary[], summary: PeriodSummary): PeriodSummary[] {
  const key = periodKey(summary);
  return [...listed.filter((p) => periodKey(p) !== key), summary];
}

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
  const [rejectKind, setRejectKind] = useState<RejectKind>("removeMatch");
  /** The statements area's file picker, for the app menu. */
  const statementsPicker = useRef<{ browse: () => void }>(null);
  const run = useRun<Summary>();
  const { state: runState, reset: resetRun } = run;
  useDockProgress(runState);
  const eta = useExtractionEta(runState.phase === "running" ? runState.events : null);
  /** The month whose last run failed or was stopped; it shows why until the user leaves it. */
  const failedKey = runPeriod && runState.phase === "failed" ? periodKey(runPeriod) : null;
  /** Setup just finished, so the detail area confirms it for a moment. */
  const [setUp, setSetUp] = useState(false);

  const configured = state?.configured === true;
  const root = state?.settings.receipts_root ?? null;
  const [compact, setCompact] = useState(isCompact);
  /** Whether the sidebar shows over the content in a narrow window. */
  const [overlay, setOverlay] = useState(false);
  const [wasCompact, setWasCompact] = useState(compact);
  if (wasCompact !== compact) {
    setWasCompact(compact);
    setOverlay(false);
  }
  const sidebarShown = compact ? overlay : sidebarSetting !== "hidden";
  const toggleSidebar = () => {
    if (compact) {
      setOverlay((shown) => !shown);
    } else {
      setSidebarSetting(sidebarShown ? "hidden" : "shown");
    }
  };
  const mainRef = useRef<HTMLDivElement>(null);
  /** Whether the detail area is scrolled, so the toolbar shows its edge over the content. */
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    setScrolled(false);
  }, [key]);

  useEffect(() => {
    const onResize = () => setCompact(isCompact());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** Tracks the scroll position of the detail area's own scroller: the detail pane or the review list. */
  function onDetailScroll(e: UIEvent<HTMLDivElement>) {
    const target = e.target;
    if (target instanceof HTMLElement && target.matches(".detail, .review-list")) {
      setScrolled(target.scrollTop > 0);
    }
  }

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

  const periods = useMemo(() => mergePeriods(listed ?? [], [fallback, selected]), [listed, fallback, selected]);
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
      const next = periodKey(period);
      if (failedKey !== null && failedKey !== next) {
        resetRun();
        setRunPeriod(null);
      }
      setStoredKey(next);
      setMessage(null);
      setLastRun(null);
      setOverlay(false);
    },
    [setStoredKey, failedKey, resetRun],
  );

  // Finishing setup selects the month to work on and confirms it briefly.
  const wasConfigured = useRef<boolean | null>(null);
  useEffect(() => {
    if (!state) {
      return;
    }
    if (wasConfigured.current === false && state.configured) {
      setSetUp(true);
      select(fallback);
    }
    wasConfigured.current = state.configured;
  }, [state, select, fallback]);

  useEffect(() => {
    if (!setUp) {
      return;
    }
    const timer = window.setTimeout(() => setSetUp(false), SET_UP_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [setUp]);

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
  const hasReceipts = summary.receipts > 0;
  const hasStatements = monthStatements.length > 0 || summary.transactions > 0;
  let runningMonth: RunningMonth | null = null;
  if (runPeriod && running) {
    runningMonth = { key: periodKey(runPeriod), progress: runProgress(runState) };
  } else if (failedKey !== null && runState.phase === "failed") {
    runningMonth = { key: failedKey, progress: null, outcome: errorKind(runState.error) === "cancelled" ? "stopped" : "failed" };
  }
  const etaText = eta === null ? null : remainingText(eta, t);
  const listReady = listed !== null || listError !== null;
  const existingKeys = useMemo(() => new Set(periods.map(periodKey)), [periods]);
  const reviewable = isReviewable(summary);

  const onStatementsScreen = Boolean(state?.configured) && listReady && !runHere && !reviewable;
  const reviewShown = Boolean(state?.configured) && listReady && !runHere && reviewable;
  useMenu(
    {
      configured,
      sidebarShown,
      rejectKind,
      acceptsStatements: onStatementsScreen && !running,
      canReconcile: hasReceipts && hasStatements,
      hasResult: reviewable,
      running,
      reviewCan: reviewShown ? reviewCan : null,
    },
    {
      newMonth: () => setSheet("new-month"),
      addStatements: () => {
        if (reviewShown) {
          reviewCommands.current?.addStatements();
        } else {
          statementsPicker.current?.browse();
        }
      },
      reconcile: () => reconcile(false),
      rerun: () => setSheet("rerun"),
      openReport: () => {
        openReport(selected.year, selected.month).catch(setMessage);
      },
      revealPeriod: reveal,
      toggleSidebar,
    },
    reviewCommands,
  );

  /** A month's context menu in the sidebar. */
  function monthMenu(month: PeriodSummary): MenuEntry[] {
    const entries: MenuEntry[] = [];
    if (isReviewable(month)) {
      entries.push({ label: t("month.openReport"), onSelect: () => openReport(month.year, month.month).catch(setMessage) });
    }
    entries.push({ label: t("month.showInFinder"), onSelect: () => revealMonth(month) });
    if (isReviewable(month)) {
      entries.push("separator", { label: t("month.rerun"), onSelect: () => setSheet("rerun"), disabled: running });
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
    const steps = buildSteps("reconcile", runState.events, outcome, t);
    const extract = steps.find((step) => step.id === "extract");
    if (etaText && extract?.status === "running") {
      extract.detail = extract.detail ? `${extract.detail} · ${etaText}` : etaText;
    }
    let title = t("progress.title", { period: label });
    if (failed !== null) {
      subtitle = cancelled ? t("month.status.stopped") : t("month.status.failed");
      const period = periodInSentence(selected, t, i18n.language);
      title = cancelled ? t("progress.stoppedTitle", { period }) : t("progress.failedTitle", { period });
    } else if (progress) {
      subtitle = etaText ? `${t("progress.readingCount", progress)} · ${etaText}` : t("progress.readingCount", progress);
    } else {
      subtitle = t("month.status.reconciling");
    }
    detail = (
      <div className="run-panel">
        <RunProgress title={title} steps={steps} />
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
          />
        </Suspense>
      );
    } else {
      subtitle = runSummary ?? status;
      let missing: string | null = null;
      if (!hasReceipts && !hasStatements) {
        missing = t("month.missing.both");
      } else if (!hasReceipts) {
        missing = t("month.missing.receipts");
      } else if (!hasStatements) {
        missing = t("month.missing.statements");
      }
      trailing = (
        <>
          <div className="toolbar-group">
            <ActionPopUpButton label={t("toolbar.moreActions")} actions={actions} className="toolbar-group__item" borderless />
          </div>
          {missing !== null && !running ? (
            <span id="reconcile-missing" className="toolbar-hint">
              {missing}
            </span>
          ) : null}
          <button
            type="button"
            className="default"
            disabled={running || missing !== null}
            aria-describedby={missing !== null && !running ? "reconcile-missing" : undefined}
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
      data-sidebar-toggle
      aria-label={sidebarShown ? t("toolbar.hideSidebar") : t("toolbar.showSidebar")}
      title={sidebarShown ? t("toolbar.hideSidebar") : t("toolbar.showSidebar")}
      onClick={toggleSidebar}
    >
      <Icon name="sidebar" size={16} />
    </button>
  ) : null;

  return (
    <div className="main" ref={mainRef} style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <Toolbar
        leading={toggle}
        leadingWidth={configured ? (showSidebar && !compact ? "var(--sidebar-width)" : 0) : undefined}
        title={configured ? label : undefined}
        subtitle={subtitle}
        trailing={trailing}
        separator={configured}
        scrolled={scrolled}
      />
      <div className="main__body" onScrollCapture={onDetailScroll}>
        <Presence>
          {showSidebar ? (
            <>
              <Sidebar
                overlay={compact}
                onDismiss={() => setOverlay(false)}
                periods={periods}
                selected={key}
                onSelect={select}
                running={runningMonth}
                loading={!listReady}
                error={listError}
                onRetry={refresh}
                onNewMonth={() => setSheet("new-month")}
                menu={monthMenu}
                accessory={<UpdateBanner placement="sidebar" onError={setMessage} />}
              />
              {compact ? null : (
                <ResizeHandle
                  label={t("sidebar.resize")}
                  width={sidebarWidth}
                  min={SIDEBAR_WIDTH.min}
                  max={SIDEBAR_WIDTH.max}
                  grows="right"
                  scope={mainRef}
                  variable="--sidebar-width"
                  onResize={setSidebarWidth}
                  onCollapse={() => setSidebarSetting("hidden")}
                />
              )}
            </>
          ) : null}
        </Presence>
        <main className={`detail ${configured && reviewable && !runHere ? "detail--review" : ""}`}>
          {showSidebar ? null : <UpdateBanner placement="detail" onError={setMessage} />}
          {setUp ? (
            <div className="banner banner--success" role="status">
              <Icon name="check" size={14} className="banner__icon--success" />
              <span className="grow">{t("welcome.setUp")}</span>
              <button type="button" className="icon" aria-label={t("common.dismiss")} title={t("common.dismiss")} onClick={() => setSetUp(false)}>
                <Icon name="xmark" size={12} />
              </button>
            </div>
          ) : null}
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
      <Presence>
        {sheet === "new-month" ? (
          <NewMonthSheet
            initial={newMonthDefault(periods, new Date())}
            existing={existingKeys}
            onCancel={() => setSheet(null)}
            onCreate={(period) =>
              createPeriod(period.year, period.month).then((entry) => {
                setListed((prev) => withSummary(prev ?? [], entry));
                select(entry);
                setSheet(null);
                refresh();
              })
            }
          />
        ) : null}
      </Presence>
      <Presence>{sheet === "rerun" ? <RerunSheet period={label} onCancel={() => setSheet(null)} onConfirm={() => reconcile(true)} /> : null}</Presence>
    </div>
  );
}
