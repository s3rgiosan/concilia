import { useTranslation } from "react-i18next";
import { Sheet } from "../components/Sheet";

/** Confirms re-running a month, which undoes the sorting of its receipts. */
export function RerunSheet({ period, onCancel, onConfirm }: { period: string; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation();
  return (
    <Sheet
      title={t("rerun.title", { period })}
      message={t("rerun.message")}
      submitLabel={t("rerun.confirm")}
      destructive
      onCancel={onCancel}
      onSubmit={onConfirm}
    />
  );
}
