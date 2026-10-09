import "./Main.css";
import { lazy, Suspense, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { errorKind, friendlyError } from "../lib/errors";
import { useAppState } from "../lib/hooks/useAppState";
import { useRun } from "../lib/hooks/useRun";
import { defaultPeriod, periodLabel, type Period } from "../lib/period";
import { buildSteps, type RunKind } from "../lib/steps";
import {
  exportReport,
  openReport,
  revealPeriod,
  startReconcile,
  startScan,
  type DroppedDecision,
  type Summary,
} from "../lib/tauri";
import { RunProgress } from "./RunProgress";
import { RunSummary } from "./RunSummary";
import { SetupEmptyState } from "./SetupEmptyState";
import { StartScreen, type Statement } from "./StartScreen";
import { UpdateBanner } from "./UpdateBanner";

const Review = lazy(() => import("../review/Review").then((m) => ({ default: m.Review })));

type Screen = "start" | "run" | "review";

/** A run's result, whichever kind it was. */
interface Outcome {
  summary: Summary;
  dropped: DroppedDecision[];
}

/** The main window: setup steps until the app is configured, then the reconciliation flow. */
export function Main() {
  const { t } = useTranslation();
  const { state, error: loadError, reload } = useAppState();
  const [screen, setScreen] = useState<Screen>("start");
  const [period, setPeriod] = useState<Period>(() => defaultPeriod(new Date()));
  const [statements, setStatements] = useState<Statement[]>([]);
  const [kind, setKind] = useState<RunKind>("reconcile");
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const run = useRun<Outcome>();

  const report = useCallback((e: unknown) => setMessage({ tone: "error", text: friendlyError(e, t) }), [t]);

  function reconcile(clearCache: boolean) {
    setMessage(null);
    setKind("reconcile");
    setScreen("run");
    const files = statements.map(({ path, bank }) => ({ path, bank }));
    run.start((onEvent) => {
      const handle = startReconcile(period.year, period.month, files, clearCache, onEvent);
      return { ...handle, promise: handle.promise.then((summary) => ({ summary, dropped: [] })) };
    });
  }

  function scan() {
    setMessage(null);
    setKind("scan");
    setScreen("run");
    run.start((onEvent) => {
      const handle = startScan(period.year, period.month, onEvent);
      return {
        ...handle,
        promise: handle.promise.then((result) => ({ summary: result.summary, dropped: result.dropped_decisions })),
      };
    });
  }

  function startOver() {
    run.reset();
    setStatements([]);
    setMessage(null);
    setScreen("start");
  }

  function saveReport() {
    exportReport(period.year, period.month).then((path) => {
      if (path) {
        setMessage({ tone: "info", text: t("results.reportSaved", { path }) });
      }
    }, report);
  }

  const label = periodLabel(period, t);
  let body = null;
  if (state && !state.configured) {
    body = <SetupEmptyState missing={state.missing} onError={report} />;
  } else if (state && screen === "review") {
    body = (
      <Suspense fallback={null}>
        <Review period={period} onBack={() => setScreen("start")} onError={report} />
      </Suspense>
    );
  } else if (state && screen === "run" && run.state.phase !== "idle") {
    const outcome = run.state.phase === "succeeded" ? "succeeded" : run.state.phase === "failed" ? "failed" : null;
    const steps = buildSteps(kind, run.state.events, outcome, t);
    if (run.state.phase === "succeeded") {
      body = (
        <RunSummary
          title={t(kind === "scan" ? "results.scanTitle" : "results.title", { period: label })}
          summary={run.state.result.summary}
          dropped={run.state.result.dropped}
          hasReport={true}
          onReview={() => setScreen("review")}
          onSaveReport={saveReport}
          onOpenReport={() => openReport(period.year, period.month).catch(report)}
          onReveal={() => revealPeriod(period.year, period.month).catch(report)}
          onNew={startOver}
        />
      );
    } else {
      const failed = run.state.phase === "failed" ? run.state.error : null;
      body = (
        <>
          <RunProgress
            title={t(kind === "scan" ? "progress.scanTitle" : "progress.title", { period: label })}
            steps={steps}
            running={run.state.phase === "running"}
            cancelling={run.state.phase === "running" && run.state.cancelling}
            onCancel={run.cancel}
          />
          {failed !== null ? (
            <div className={`banner ${errorKind(failed) === "cancelled" ? "banner--info" : "banner--error"}`} role="alert">
              <Icon name="warning" size={14} />
              <span className="grow">{errorKind(failed) === "cancelled" ? t("results.stopped") : friendlyError(failed, t)}</span>
              <button type="button" className="banner__action" onClick={() => setScreen("start")}>
                {t("results.tryAgain")}
              </button>
            </div>
          ) : null}
        </>
      );
    }
  } else if (state) {
    body = (
      <StartScreen
        period={period}
        onPeriod={(next) => {
          setMessage(null);
          setPeriod(next);
        }}
        statements={statements}
        onStatements={setStatements}
        onReconcile={reconcile}
        onResume={() => setScreen("review")}
        onScan={scan}
        onError={report}
      />
    );
  }

  return (
    <div className={`main ${screen === "review" && state?.configured ? "main--review" : ""}`}>
      <UpdateBanner onError={report} />
      {loadError ? (
        <div className="banner banner--error" role="alert">
          <Icon name="warning" size={14} />
          <span className="grow">{friendlyError(loadError, t)}</span>
          <button type="button" className="banner__action" onClick={reload}>
            {t("common.tryAgain")}
          </button>
        </div>
      ) : null}
      {message ? (
        <div className={`banner banner--${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>
          <Icon name={message.tone === "error" ? "warning" : "check"} size={14} />
          <span className="grow">{message.text}</span>
          <button type="button" className="icon" aria-label={t("common.close")} onClick={() => setMessage(null)}>
            <Icon name="xmark" size={12} />
          </button>
        </div>
      ) : null}
      {body}
    </div>
  );
}
