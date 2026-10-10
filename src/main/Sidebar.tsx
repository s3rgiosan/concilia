import { useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ErrorText } from "../components/ErrorText";
import { Icon } from "../components/Icon";
import { groupByYear, periodKey, statusLine, type Period } from "../lib/period";
import type { PeriodSummary } from "../lib/tauri";

/** The month being reconciled, with its progress ("4 / 38") once receipts are being read. */
export interface RunningMonth {
  key: string;
  progress: string | null;
}

function optionId(key: string): string {
  return `month-${key}`;
}

/**
 * The months, newest first under year headers, as a single-selection list. Each row names the
 * month and says where it stands; ↑/↓, Home and End move the selection.
 */
export function Sidebar({
  periods,
  selected,
  onSelect,
  running,
  error,
  onRetry,
  onNewMonth,
  width,
}: {
  periods: PeriodSummary[];
  selected: string;
  onSelect: (period: Period) => void;
  running: RunningMonth | null;
  error: unknown;
  onRetry: () => void;
  onNewMonth: () => void;
  width: number;
}) {
  const { t } = useTranslation();
  const list = useRef<HTMLDivElement>(null);
  const groups = groupByYear(periods);
  const index = periods.findIndex((p) => periodKey(p) === selected);

  function select(summary: PeriodSummary) {
    onSelect({ year: summary.year, month: summary.month });
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    let next: number;
    switch (e.key) {
      case "ArrowDown":
        next = Math.min(index + 1, periods.length - 1);
        break;
      case "ArrowUp":
        next = Math.max(index - 1, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = periods.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const target = periods[next];
    if (target && next !== index) {
      select(target);
      document.getElementById(optionId(periodKey(target)))?.scrollIntoView?.({ block: "nearest" });
    }
  }

  return (
    <nav className="sidebar" style={{ width }} aria-label={t("sidebar.months")}>
      <div
        ref={list}
        className="sidebar__list"
        role="listbox"
        tabIndex={0}
        aria-label={t("sidebar.months")}
        aria-activedescendant={index >= 0 ? optionId(selected) : undefined}
        onKeyDown={onKeyDown}
      >
        {groups.map((group) => (
          <div key={group.year} role="group" aria-labelledby={`year-${group.year}`} className="sidebar__group">
            <div id={`year-${group.year}`} className="sidebar__year" role="presentation">
              {group.year}
            </div>
            {group.periods.map((summary) => {
              const key = periodKey(summary);
              const isSelected = key === selected;
              const run = running?.key === key ? running : null;
              const line = statusLine(summary, t);
              return (
                <div
                  key={key}
                  id={optionId(key)}
                  role="option"
                  aria-selected={isSelected}
                  className={`sidebar__row ${isSelected ? "sidebar__row--selected" : ""}`}
                  onClick={() => {
                    select(summary);
                    list.current?.focus();
                  }}
                >
                  <span className="sidebar__month">{t(`form.months.${summary.month}`)}</span>
                  <span className="sidebar__status">
                    {run ? (
                      <span className="spinner sidebar__spinner" aria-hidden="true" />
                    ) : (
                      <span className={`dot dot--${line.tone}`} aria-hidden="true" />
                    )}
                    <span className="sidebar__label">{run ? (run.progress ?? t("month.status.reconciling")) : line.label}</span>
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {error ? (
        <div className="banner banner--error sidebar__error" role="alert">
          <span className="grow">
            <ErrorText error={error} />
          </span>
          <button type="button" className="banner__action" onClick={onRetry}>
            {t("common.tryAgain")}
          </button>
        </div>
      ) : null}
      <footer className="sidebar__footer">
        <button type="button" className="icon" aria-label={t("sidebar.newMonth")} title={t("sidebar.newMonth")} onClick={onNewMonth}>
          <Icon name="plus" size={14} />
        </button>
      </footer>
    </nav>
  );
}
