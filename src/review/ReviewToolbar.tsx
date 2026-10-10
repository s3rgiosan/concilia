import type { KeyboardEvent, Ref } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { ActionPopUpButton, PopUpButton, type PopUpAction } from "../components/PopUpButton";
import type { MenuEntry } from "../lib/popUpMenu";
import { FILTERS, type Filter } from "./effective";

/** How far the toolbar has given way to a narrow window. */
export type ToolbarLevel = 0 | 1 | 2;

/** The compact levels past the full toolbar. */
export const TOOLBAR_LEVELS = 2;

/**
 * The status filter as a segmented control with radio semantics: one segment is checked and in
 * the tab order, and the arrow keys, Home and End move the choice.
 */
function FilterControl({ filter, counts, onFilter, showCounts }: { filter: Filter; counts: Record<Filter, number>; onFilter: (filter: Filter) => void; showCounts: boolean }) {
  const { t } = useTranslation();

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const index = FILTERS.indexOf(filter);
    let next: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (index + 1) % FILTERS.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (index - 1 + FILTERS.length) % FILTERS.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = FILTERS.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    onFilter(FILTERS[next]);
    e.currentTarget.querySelectorAll<HTMLElement>("[role=radio]")[next]?.focus();
  }

  return (
    <div className="segmented review-filter" role="radiogroup" aria-label={t("review.filter")} onKeyDown={onKeyDown}>
      {FILTERS.map((key) => {
        const on = filter === key;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={`segmented__item ${on ? "segmented__item--on" : ""}`}
            onClick={() => onFilter(key)}
          >
            {t(`review.filters.${key}`)}
            {showCounts ? <span className="segmented__count numeric">{counts[key]}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The review's controls in the window toolbar: the status filter, then Scan for New Receipts,
 * Export Report… and the `•••` menu in one group, the primary button and search. The `•••` menu
 * starts with Add Statements…, except for a finalized month, then the month's other actions. The
 * primary button is Finalize…, the default button once nothing is left to decide, or Open Report
 * for a finalized month. As the window narrows (`level`), the counts go, Scan and Export move
 * into the `•••` menu, and then the filter becomes a pop-up button.
 */
export function ReviewToolbar({
  filter,
  counts,
  onFilter,
  search,
  searchRef,
  onSearch,
  onSearchKeyDown,
  onClearSearch,
  busy,
  finalized,
  moreActions,
  onScan,
  onAddStatements,
  onExport,
  onFinalize,
  onOpenReport,
  level,
}: {
  filter: Filter;
  counts: Record<Filter, number>;
  onFilter: (filter: Filter) => void;
  search: string;
  searchRef: Ref<HTMLInputElement>;
  onSearch: (search: string) => void;
  onSearchKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  onClearSearch: () => void;
  /** A scan or Finalize is running. */
  busy: boolean;
  finalized: boolean;
  moreActions: PopUpAction[];
  onScan: () => void;
  onAddStatements: () => void;
  onExport: () => void;
  onFinalize: () => void;
  onOpenReport: () => void;
  level: ToolbarLevel;
}) {
  const { t } = useTranslation();
  const scanLabel = t("review.scan");
  const exportLabel = t("review.exportReport");
  const clearLabel = t("review.clearSearch");
  const scanDisabled = busy || finalized;
  const own: MenuEntry[] = [];
  if (!finalized) {
    own.push({ label: t("month.addStatements"), onSelect: onAddStatements, disabled: busy });
  }
  if (level > 0) {
    own.push({ label: scanLabel, onSelect: onScan, disabled: scanDisabled }, { label: exportLabel, onSelect: onExport, disabled: busy });
  }
  const menu: MenuEntry[] = own.length > 0 ? [...own, "separator", ...moreActions] : moreActions;

  return (
    <>
      {level === 2 ? (
        <PopUpButton
          label={t("review.filter")}
          value={filter}
          options={FILTERS.map((key) => ({ value: key, label: t(`review.filters.${key}`) }))}
          onChange={onFilter}
        />
      ) : (
        <FilterControl filter={filter} counts={counts} onFilter={onFilter} showCounts={level === 0} />
      )}
      <div className="toolbar-group">
        {level === 0 ? (
          <>
            <button type="button" className="icon toolbar-group__item" aria-label={scanLabel} title={scanLabel} onClick={onScan} disabled={scanDisabled}>
              <Icon name="scan" size={16} />
            </button>
            <button type="button" className="icon toolbar-group__item" aria-label={exportLabel} title={exportLabel} onClick={onExport} disabled={busy}>
              <Icon name="share" size={16} />
            </button>
          </>
        ) : null}
        <ActionPopUpButton label={t("toolbar.moreActions")} actions={menu} className="toolbar-group__item" borderless />
      </div>
      {finalized ? (
        <button type="button" className="default" onClick={onOpenReport} disabled={busy}>
          {t("month.openReport")}
        </button>
      ) : (
        <button type="button" className={counts.pending === 0 ? "default" : undefined} onClick={onFinalize} disabled={busy}>
          {t("review.finalize")}
        </button>
      )}
      <div className="search review-search">
        <Icon name="search" size={13} />
        <input
          ref={searchRef}
          type="search"
          value={search}
          placeholder={t("review.search")}
          aria-label={t("review.search")}
          onChange={(e) => onSearch(e.target.value)}
          onKeyDown={onSearchKeyDown}
        />
        {search ? (
          <button type="button" className="search__clear" aria-label={clearLabel} title={clearLabel} onClick={onClearSearch}>
            <Icon name="clear" size={13} />
          </button>
        ) : null}
      </div>
    </>
  );
}
