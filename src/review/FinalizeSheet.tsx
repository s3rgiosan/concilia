import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../components/Sheet";

/** Confirms Finalize, which moves every receipt file and cannot be undone. */
export function FinalizeSheet({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation();
  const [consent, setConsent] = useState(false);
  return (
    <Sheet
      title={t("review.finalizeConfirm.title")}
      message={t("review.finalizeConfirm.body")}
      submitLabel={t("review.finalizeConfirm.cta")}
      submitDisabled={!consent}
      destructive
      busy={busy}
      onCancel={onCancel}
      onSubmit={onConfirm}
    >
      <label className="consent">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        {t("review.finalizeConfirm.checkbox")}
      </label>
    </Sheet>
  );
}
