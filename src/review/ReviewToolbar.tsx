import type { KeyboardEvent, Ref } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { ActionPopUpButton, type PopUpAction } from "../components/PopUpButton";
import { FILTERS, type Filter } from "./effective";

/**
 * The review's controls in the window toolbar: the status filter with counts, search, Scan,
 * Export Report…, the month's other actions, Finalize… and the inspector toggle.
 */
export function ReviewToolbar({
  filter,
  counts,
  onFilter,
  search,
  searchRef,
  onSearch,
  onSearchKeyDown,
  busy,
  finalized,
  moreActions,
  inspectorShown,
  onScan,
  onExport,
  onFinalize,
  onToggleInspector,
  compact,
}: {
  filter: Filter;
  counts: Record<Filter, number>;
  onFilter: (filter: Filter) => void;
  search: string;
  searchRef: Ref<HTMLInputElement>;
  onSearch: (search: string) => void;
  onSearchKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** A scan or Finalize is running. */
  busy: boolean;
  finalized: boolean;
  moreActions: PopUpAction[];
  inspectorShown: boolean;
  onScan: () => void;
  onExport: () => void;
  onFinalize: () => void;
  onToggleInspector: () => void;
  /** Leaves out the filter counts and moves Export Report… into the `•••` menu, for narrow windows. */
  compact: boolean;
}) {
  const { t } = useTranslation();
  const scanLabel = t("review.scan");
  const inspectorLabel = inspectorShown ? t("review.hideInspector") : t("review.showInspector");
  return (
    <>
      <div className={`segmented review-filter ${compact ? "review-filter--compact" : ""}`} role="group" aria-label={t("review.filter")}>
        {FILTERS.map((key) => (
          <button
            key={key}
            type="button"
            className={`segmented__item ${filter === key ? "segmented__item--on" : ""}`}
            aria-pressed={filter === key}
            onClick={() => onFilter(key)}
          >
            {t(`review.filters.${key}`)}
            {compact ? null : <span className="segmented__count numeric">{counts[key]}</span>}
          </button>
        ))}
      </div>
      <label className="search review-search">
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
      </label>
      <button
        type="button"
        className="icon titlebar__button"
        aria-label={scanLabel}
        title={scanLabel}
        onClick={onScan}
        disabled={busy || finalized}
      >
        <Icon name="refresh" size={15} />
      </button>
      {compact ? null : (
        <button type="button" onClick={onExport} disabled={busy}>
          {t("review.exportReport")}
        </button>
      )}
      <ActionPopUpButton
        label={t("toolbar.moreActions")}
        actions={compact ? [{ label: t("review.exportReport"), onSelect: onExport, disabled: busy }, ...moreActions] : moreActions}
      />
      {finalized ? null : (
        <button type="button" className="default" onClick={onFinalize} disabled={busy}>
          {t("review.finalize")}
        </button>
      )}
      <button
        type="button"
        className="icon titlebar__button"
        aria-label={inspectorLabel}
        title={inspectorLabel}
        aria-expanded={inspectorShown}
        onClick={onToggleInspector}
      >
        <Icon name="inspector" size={16} />
      </button>
    </>
  );
}
