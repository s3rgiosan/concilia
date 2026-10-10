import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PopUpButton } from "../components/PopUpButton";
import { Sheet, SheetNote } from "../components/Sheet";
import { monthOptions, periodKey, periodLabel, yearOptions, type Period } from "../lib/period";

/**
 * Picks a month and year to add to the sidebar. Folders appear once the month gets files. A month
 * already in the sidebar cannot be created again.
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
  onCreate: (period: Period) => void;
}) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<Period>(initial);
  const exists = existing.has(periodKey(period));
  return (
    <Sheet
      title={t("newMonth.title")}
      submitLabel={t("newMonth.create")}
      submitDisabled={exists}
      onCancel={onCancel}
      onSubmit={() => onCreate(period)}
      width={360}
    >
      <div className="sheet__grid">
        <label htmlFor="new-month-month">{t("form.month")}</label>
        <PopUpButton
          id="new-month-month"
          label={t("form.month")}
          value={period.month}
          options={monthOptions(t)}
          onChange={(month) => setPeriod((prev) => ({ ...prev, month }))}
        />
        <label htmlFor="new-month-year">{t("form.year")}</label>
        <PopUpButton
          id="new-month-year"
          label={t("form.year")}
          value={period.year}
          options={yearOptions(new Date()).map((year) => ({ value: year, label: year }))}
          onChange={(year) => setPeriod((prev) => ({ ...prev, year }))}
        />
      </div>
      {exists ? <SheetNote tone="warning">{t("newMonth.exists", { month: periodLabel(period, t) })}</SheetNote> : null}
    </Sheet>
  );
}
