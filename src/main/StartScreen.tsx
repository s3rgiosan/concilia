import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { PopUpButton } from "../components/PopUpButton";
import { useFileDrop } from "../lib/hooks/useFileDrop";
import { monthOptions, yearOptions, type Period } from "../lib/period";
import { periodStatus, pickStatements, type PeriodStatus, type StatementInput } from "../lib/tauri";

/** Banks Concilia can parse, as the backend's `Bank` keys. */
export const BANKS = [{ value: "cgd", label: "CGD" }];

export interface Statement extends StatementInput {
  id: string;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function isPdf(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}

/** Picks the month, collects statements and starts a run, or resumes one. */
export function StartScreen({
  period,
  onPeriod,
  statements,
  onStatements,
  onReconcile,
  onResume,
  onScan,
  onError,
}: {
  period: Period;
  onPeriod: (period: Period) => void;
  statements: Statement[];
  onStatements: (statements: Statement[]) => void;
  onReconcile: (clearCache: boolean) => void;
  onResume: () => void;
  onScan: () => void;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PeriodStatus | null>(null);
  const [rejected, setRejected] = useState(false);

  useEffect(() => {
    let current = true;
    setStatus(null);
    periodStatus(period.year, period.month).then(
      (next) => {
        if (current) {
          setStatus(next);
        }
      },
      (e) => {
        if (current) {
          onError(e);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [period, onError]);

  function add(paths: string[]) {
    const pdfs = paths.filter(isPdf);
    setRejected(pdfs.length < paths.length);
    const known = new Set(statements.map((s) => s.path));
    const fresh = pdfs.filter((p) => !known.has(p)).map((path) => ({ id: crypto.randomUUID(), path, bank: BANKS[0].value }));
    if (fresh.length > 0) {
      onStatements([...statements, ...fresh]);
    }
  }

  const dragging = useFileDrop(add);

  function browse() {
    pickStatements().then((paths) => {
      if (paths.length > 0) {
        add(paths);
      }
    }, onError);
  }

  return (
    <section className="start" aria-labelledby="start-title">
      <header className="start__header">
        <h1 id="start-title" className="start__title">
          {t("form.title")}
        </h1>
        <div className="start__period">
          <PopUpButton
            label={t("form.month")}
            value={period.month}
            options={monthOptions(t)}
            onChange={(month) => onPeriod({ ...period, month })}
          />
          <PopUpButton
            label={t("form.year")}
            value={period.year}
            options={yearOptions(new Date()).map((y) => ({ value: y, label: y }))}
            onChange={(year) => onPeriod({ ...period, year })}
          />
        </div>
      </header>

      {status?.exists ? (
        <div className="banner banner--info resume" role="status">
          <Icon name="doc" size={14} />
          <div className="grow">
            <p className="resume__text">{status.applied ? t("form.priorApplied") : t("form.priorUnfinished")}</p>
            <p className="resume__hint muted">{t("form.rerunHint")}</p>
          </div>
          <div className="resume__actions">
            <button type="button" className="banner__action" onClick={onResume}>
              {t("form.resumeReview")}
            </button>
            {!status.applied ? (
              <button type="button" className="banner__action" onClick={onScan}>
                {t("form.scan")}
              </button>
            ) : null}
            <button
              type="button"
              className="banner__action"
              onClick={() => onReconcile(true)}
              disabled={!status.has_transactions && statements.length === 0}
            >
              {t("form.rerun")}
            </button>
          </div>
        </div>
      ) : null}

      <section className="statements" aria-labelledby="statements-title">
        <h2 id="statements-title" className="form-section__title">
          {t("form.statements")}
        </h2>
        <div className={`dropzone ${dragging ? "dropzone--over" : ""}`}>
          {statements.length === 0 ? (
            <div className="dropzone__empty">
              <Icon name="drop" size={28} />
              <span>{t("form.dropHint")}</span>
            </div>
          ) : (
            <ul className="statements__list">
              {statements.map((statement) => (
                <li key={statement.id} className="statements__row">
                  <Icon name="doc" size={14} />
                  <span className="grow statements__name" title={statement.path}>
                    {fileName(statement.path)}
                  </span>
                  <PopUpButton
                    label={t("form.bank")}
                    value={statement.bank}
                    options={BANKS}
                    onChange={(bank) => onStatements(statements.map((s) => (s.id === statement.id ? { ...s, bank } : s)))}
                  />
                  <button
                    type="button"
                    className="icon"
                    aria-label={t("form.removeStatement", { name: fileName(statement.path) })}
                    onClick={() => onStatements(statements.filter((s) => s.id !== statement.id))}
                  >
                    <Icon name="xmark" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {rejected ? <p className="statements__note muted">{t("form.notPdf")}</p> : null}
      </section>

      <footer className="start__actions">
        <button type="button" onClick={browse}>
          {t("form.addStatements")}
        </button>
        <span className="grow" />
        <button type="button" className="default" disabled={statements.length === 0} onClick={() => onReconcile(false)}>
          {t("form.run")}
        </button>
      </footer>
    </section>
  );
}
