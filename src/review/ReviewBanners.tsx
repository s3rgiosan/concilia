import { useTranslation } from "react-i18next";
import { Banner } from "../components/Banner";
import { fileName } from "../lib/paths";
import { openReport, revealPeriod, type DroppedDecision, type RefusedFile } from "../lib/tauri";
import { periodLabel, type Period } from "../lib/period";
import type { Notice } from "./notices";

export interface ReviewBannersProps {
  period: Period;
  /** Finalize succeeded while the review was open. */
  finalized: boolean;
  notice: Notice | null;
  dropped: DroppedDecision[];
  /** Files Concilia refused to read. */
  refused: RefusedFile[];
  onDismissFinalized: () => void;
  onDismissNotice: () => void;
  onDismissDropped: () => void;
  onDismissRefused: () => void;
  onError: (e: unknown) => void;
}

/** The messages over the list: the completion of Finalize, a notice, the decisions a run dropped, and the files Concilia can't read. */
export function ReviewBanners({ period, finalized, notice, dropped, refused, onDismissFinalized, onDismissNotice, onDismissDropped, onDismissRefused, onError }: ReviewBannersProps) {
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
      {refused.length > 0 ? (
        <Banner
          tone="warn"
          icon="warning"
          className="review__banner"
          onDismiss={onDismissRefused}
          actions={
            <button type="button" className="banner__action" onClick={() => revealPeriod(year, month).catch(onError)}>
              {t("month.showInFinder")}
            </button>
          }
        >
          {t("review.refusedBanner", { count: refused.length })}
          {refused.map((file) => (
            <span key={file.file} className="review__refused-file">
              {t("review.refusedFile", {
                name: fileName(file.file),
                reason: t(`review.refusedReason.${file.code}`, { defaultValue: t("review.refusedReason.other") }),
              })}
            </span>
          ))}
        </Banner>
      ) : null}
    </>
  );
}
