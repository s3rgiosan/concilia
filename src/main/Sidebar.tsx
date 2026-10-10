import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ErrorText } from "../components/ErrorText";
import { Icon } from "../components/Icon";
import { groupByYear, periodKey, statusLine, type Period } from "../lib/period";
import { useLatest } from "../lib/hooks/useLatest";
import { popUpMenu, type MenuEntry } from "../lib/popUpMenu";
import type { PeriodSummary } from "../lib/tauri";

/**
 * The month being reconciled, with how many receipts have been read once reading starts, or the
 * month whose last run failed or was stopped.
 */
export interface RunningMonth {
  key: string;
  progress: { current: number; total: number } | null;
  /** How the run ended; absent while it runs. */
  outcome?: "failed" | "stopped";
}

function optionId(key: string): string {
  return `month-${key}`;
}

/**
 * The months, newest first under year headers, as a single-selection list. Each row names the
 * month and says where it stands, once the months have loaded. A press selects a month, ↑/↓,
 * Home and End move the selection, and a right click offers the month's commands from `menu`.
 * Its width is the `--sidebar-width` custom property. As an `overlay` it lies over the content
 * and takes focus; Esc or a press outside it (other than on the sidebar button) runs `onDismiss`.
 * `accessory`, such as an update notice, sits above the footer.
 */
export function Sidebar({
  overlay = false,
  onDismiss,
  periods,
  selected,
  onSelect,
  running,
  loading,
  error,
  onRetry,
  onNewMonth,
  menu,
  accessory,
}: {
  overlay?: boolean;
  onDismiss?: () => void;
  periods: PeriodSummary[];
  selected: string;
  onSelect: (period: Period) => void;
  running: RunningMonth | null;
  /** The months are still loading, so their statuses are not known yet. */
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onNewMonth: () => void;
  /** The commands for a month's context menu. */
  menu: (summary: PeriodSummary) => MenuEntry[];
  accessory?: ReactNode;
}) {
  const { t } = useTranslation();
  const list = useRef<HTMLDivElement>(null);
  const groups = groupByYear(periods);
  const index = periods.findIndex((p) => periodKey(p) === selected);
  const nav = useRef<HTMLElement>(null);
  const dismiss = useLatest(onDismiss);

  useEffect(() => {
    if (!overlay) {
      return;
    }
    list.current?.focus();
    function onPointerDown(e: PointerEvent) {
      const target = e.target;
      if (!(target instanceof Element) || nav.current?.contains(target) || target.closest("[data-sidebar-toggle]")) {
        return;
      }
      dismiss.current?.();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [overlay, dismiss]);

  function select(summary: PeriodSummary) {
    onSelect({ year: summary.year, month: summary.month });
  }

  function showMenu(summary: PeriodSummary, e: MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    select(summary);
    list.current?.focus();
    void popUpMenu(menu(summary), { x: e.clientX, y: e.clientY });
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    let next: number;
    switch (e.key) {
      case "Escape":
        if (overlay) {
          e.preventDefault();
          onDismiss?.();
          document.querySelector<HTMLElement>("[data-sidebar-toggle]")?.focus();
        }
        return;
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
    <nav ref={nav} className={overlay ? "sidebar sidebar--overlay" : "sidebar"} aria-label={t("sidebar.months")}>
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
                  onMouseDown={(e) => {
                    if (e.button === 0) {
                      select(summary);
                      list.current?.focus();
                    }
                  }}
                  onContextMenu={(e) => showMenu(summary, e)}
                >
                  <span className="sidebar__month">{t(`form.months.${summary.month}`)}</span>
                  {run?.outcome ? (
                    <span className="sidebar__status">
                      <span className={`dot ${run.outcome === "failed" ? "dot--red" : "dot--gray"}`} aria-hidden="true" />
                      <span className="sidebar__label">{t(`month.status.${run.outcome}`)}</span>
                    </span>
                  ) : run ? (
                    <RunStatus progress={run.progress} />
                  ) : (
                    <span className="sidebar__status">
                      {loading ? null : <span className={`dot dot--${line.tone}`} aria-hidden="true" />}
                      <span className="sidebar__label">{loading ? "\u00a0" : line.label}</span>
                    </span>
                  )}
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
      {accessory}
      <footer className="sidebar__footer">
        <button type="button" className="icon" aria-label={t("sidebar.newMonth")} title={t("sidebar.newMonth")} onClick={onNewMonth}>
          <Icon name="plus" size={14} />
        </button>
      </footer>
    </nav>
  );
}

/** A running month's status: a spinner and the reading progress, exposed as a progress bar once it is known. */
function RunStatus({ progress }: { progress: RunningMonth["progress"] }) {
  const { t } = useTranslation();
  const label = progress ? t("progress.readingCount", progress) : t("month.status.reconciling");
  return (
    <span
      className="sidebar__status"
      role={progress ? "progressbar" : undefined}
      aria-valuemin={progress ? 0 : undefined}
      aria-valuemax={progress?.total}
      aria-valuenow={progress?.current}
      aria-valuetext={progress ? label : undefined}
    >
      <span className="spinner sidebar__spinner" aria-hidden="true" />
      <span className="sidebar__label">{label}</span>
    </span>
  );
}
