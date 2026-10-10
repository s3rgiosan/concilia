import { useTranslation } from "react-i18next";
import type { Filter } from "./effective";

export interface ReviewEmptyProps {
  filter: Filter;
  search: string;
  /** How many transactions still wait for a decision. */
  pending: number;
  finalized: boolean;
  canFinalize: boolean;
  onFinalize: () => void;
  onShowPending: () => void;
}

/** The list's message when it shows no rows, with the step that leads on. */
export function ReviewEmpty({ filter, search, pending, finalized, canFinalize, onFinalize, onShowPending }: ReviewEmptyProps) {
  const { t } = useTranslation();
  const query = search.trim();
  if (query) {
    return <p className="review__empty-title">{t("review.noResults", { query })}</p>;
  }
  if (filter === "pending" && pending === 0) {
    return (
      <>
        <p className="review__empty-title">{t("review.empty.doneTitle")}</p>
        {finalized ? null : (
          <>
            <p className="review__empty-message">{t("review.empty.doneMessage")}</p>
            <button type="button" className="default" onClick={onFinalize} disabled={!canFinalize}>
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
        <button type="button" onClick={onShowPending}>
          {t("review.empty.showThem")}
        </button>
      </>
    );
  }
  return <p className="review__empty-title">{t(`review.empty.none_${filter}`)}</p>;
}
