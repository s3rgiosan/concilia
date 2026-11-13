import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorText } from "../components/ErrorText";
import { PopUpButton } from "../components/PopUpButton";
import { Sheet, SheetNote } from "../components/Sheet";
import { monthOptions, periodKey, periodLabel, yearOptions, type Period } from "../lib/period";

/**
 * Picks a month and year to add to the sidebar. Create makes the month's receipts folder through
 * `onCreate` and shows why when that fails. A month already in the sidebar cannot be created again.
 */
export function NewMonthSheet({
  initial,
  existing,
  onCancel,
  onCreate,
}: {
  initial: Period;
  /** Keys of the months the sidebar lists. */
  existing: Set<string>;
  onCancel: () => void;
  /** Creates the month; the sheet stays open with the reason when it rejects. */
  onCreate: (period: Period) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<Period>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const exists = existing.has(periodKey(period));

  function create() {
    setBusy(true);
    setError(null);
    onCreate(period).catch((e) => {
      setError(e);
      setBusy(false);
    });
  }

  return (
    <Sheet
      title={t("newMonth.title")}
      submitLabel={t("newMonth.create")}
      submitDisabled={exists}
      busy={busy}
      onCancel={onCancel}
      onSubmit={create}
      width={360}
    >
      <div className="sheet__grid">
        <label htmlFor="new-month-month">{t("form.month")}</label>
        <PopUpButton
          id="new-month-month"
          label={t("form.month")}
          value={period.month}
          options={monthOptions(t)}
          disabled={busy}
          onChange={(month) => setPeriod((prev) => ({ ...prev, month }))}
        />
        <label htmlFor="new-month-year">{t("form.year")}</label>
        <PopUpButton
          id="new-month-year"
          label={t("form.year")}
          value={period.year}
          options={yearOptions(new Date()).map((year) => ({ value: year, label: year }))}
          disabled={busy}
          onChange={(year) => setPeriod((prev) => ({ ...prev, year }))}
        />
      </div>
      {exists ? <SheetNote tone="warning">{t("newMonth.exists", { month: periodLabel(period, t) })}</SheetNote> : null}
      {error !== null ? (
        <SheetNote>
          <ErrorText error={error} />
        </SheetNote>
      ) : null}
    </Sheet>
  );
}
