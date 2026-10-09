import { useTranslation } from "react-i18next";
import type { Period } from "../lib/period";
import { periodLabel } from "../lib/period";

/** The review of a month's matches. */
export function Review({ period, onBack }: { period: Period; onBack: () => void; onError: (e: unknown) => void }) {
  const { t } = useTranslation();
  return (
    <section className="start">
      <h1 className="start__title">{`${t("nav.review")} · ${periodLabel(period, t)}`}</h1>
      <footer className="start__actions">
        <button type="button" onClick={onBack}>
          {t("nav.start")}
        </button>
      </footer>
    </section>
  );
}
