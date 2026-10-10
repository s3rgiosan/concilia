import { useTranslation } from "react-i18next";
import { Banner } from "../components/Banner";
import { openReport, revealPeriod, type DroppedDecision } from "../lib/tauri";
import { periodLabel, type Period } from "../lib/period";
import type { Notice } from "./notices";

export interface ReviewBannersProps {
  period: Period;
  /** Finalize succeeded while the review was open. */
  finalized: boolean;
  notice: Notice | null;
  dropped: DroppedDecision[];
  onDismissFinalized: () => void;
  onDismissNotice: () => void;
  onDismissDropped: () => void;
  onError: (e: unknown) => void;
}

/** The messages over the list: the completion of Finalize, a notice, and the decisions a run dropped. */
export function ReviewBanners({ period, finalized, notice, dropped, onDismissFinalized, onDismissNotice, onDismissDropped, onError }: ReviewBannersProps) {
  const { t } = useTranslation();
  const { year, month } = period;
  return (
    <>
      {finalized ? (
        <Banner
          tone="success"
          icon="check"
          className="review__banner"
          onDismiss={onDismissFinalized}
          actions={
            <>
              <button type="button" className="banner__action" onClick={() => revealPeriod(year, month).catch(onError)}>
                {t("month.showInFinder")}
              </button>
              <button type="button" className="banner__action" onClick={() => openReport(year, month).catch(onError)}>
                {t("month.openReport")}
              </button>
            </>
          }
        >
          {t("review.finalizedBanner", { period: periodLabel(period, t) })}
        </Banner>
      ) : null}
      {notice ? (
        <Banner tone={notice.tone} icon={notice.icon ?? (notice.tone === "success" ? "check" : "rules")} className="review__banner" onDismiss={onDismissNotice}>
          {notice.text}
        </Banner>
      ) : null}
      {dropped.length > 0 ? (
        <Banner tone="warn" icon="warning" className="review__banner" onDismiss={onDismissDropped}>
          {t("review.scanDroppedBanner", { count: dropped.length, names: dropped.map((d) => d.description).join(", ") })}
        </Banner>
      ) : null}
    </>
  );
}
