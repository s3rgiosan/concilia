import { useTranslation } from "react-i18next";
import type { DroppedDecision, Summary } from "../lib/tauri";

/** Counts of a finished run and what to do next. */
export function RunSummary({
  title,
  summary,
  dropped,
  hasReport,
  onReview,
  onSaveReport,
  onOpenReport,
  onReveal,
  onNew,
}: {
  title: string;
  summary: Summary;
  dropped: DroppedDecision[];
  hasReport: boolean;
  onReview: () => void;
  onSaveReport: () => void;
  onOpenReport: () => void;
  onReveal: () => void;
  onNew: () => void;
}) {
  const { t } = useTranslation();
  const stats = [
    { id: "matched", value: summary.matched, label: t("results.matched"), note: t("results.matchRate", { matchRate: summary.matchRate }) },
    { id: "review", value: summary.review, label: t("results.review"), note: t("results.needsAttention") },
    { id: "unmatched", value: summary.unmatched, label: t("results.unmatched"), note: t("results.noReceipt") },
  ];
  if (summary.bankFees > 0) {
    stats.push({ id: "fees", value: summary.bankFees, label: t("results.bankFees"), note: t("results.autoDetected") });
  }

  return (
    <section className="summary" aria-labelledby="summary-title">
      <h1 id="summary-title" className="start__title">
        {title}
      </h1>
      <p className="muted summary__subtitle">
        {t("results.subtitle", { totalTransactions: summary.totalTransactions, totalReceipts: summary.totalReceipts })}
      </p>
      <dl className="stats">
        {stats.map((stat) => (
          <div key={stat.id} className={`stat stat--${stat.id}`}>
            <dt className="stat__label">{stat.label}</dt>
            <dd className="stat__value numeric">{stat.value}</dd>
            <dd className="stat__note muted">{stat.note}</dd>
          </div>
        ))}
      </dl>
      {dropped.length > 0 ? (
        <div className="banner banner--warn" role="status">
          <div>
            <p className="resume__text">{t("results.droppedTitle")}</p>
            <ul className="summary__dropped">
              {dropped.map((d) => (
                <li key={d.txId}>
                  {d.description} ({d.removedReceiptFiles.join(", ")})
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      <footer className="start__actions">
        <button type="button" onClick={onNew}>
          {t("results.newReconciliation")}
        </button>
        <button type="button" onClick={onReveal}>
          {t("results.reveal")}
        </button>
        <span className="grow" />
        {hasReport ? (
          <>
            <button type="button" onClick={onOpenReport}>
              {t("results.openReport")}
            </button>
            <button type="button" onClick={onSaveReport}>
              {t("results.saveReport")}
            </button>
          </>
        ) : null}
        <button type="button" className="default" onClick={onReview}>
          {t("results.reviewAndValidate")}
        </button>
      </footer>
    </section>
  );
}
