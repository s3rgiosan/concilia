import { useTranslation } from "react-i18next";
import { Icon, type IconName } from "../components/Icon";
import { formatMoney } from "../lib/money";
import type { ReceiptMeta } from "../lib/tauri";

export interface ReceiptAction {
  id: string;
  label: string;
  icon: IconName;
  onClick: () => void;
  disabled?: boolean;
  spinning?: boolean;
  tone?: "accept" | "reject";
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** One receipt under a transaction: vendor, file, date, amount and its actions. */
export function ReceiptRow({
  receipt,
  reason,
  mismatch,
  selected,
  onSelect,
  actions,
}: {
  receipt: ReceiptMeta;
  reason?: string;
  mismatch: boolean;
  selected: boolean;
  onSelect: () => void;
  actions: ReceiptAction[];
}) {
  const { t, i18n } = useTranslation();
  const name = fileName(receipt.file);
  return (
    <li className={`receipt ${selected ? "receipt--selected" : ""}`}>
      <button type="button" className="receipt__main" onClick={onSelect} aria-pressed={selected}>
        <span className="receipt__vendor">{receipt.vendor ?? name}</span>
        <span className="receipt__meta muted">
          {receipt.vendor ? <span className="receipt__file">{name}</span> : null}
          <span>{receipt.date ?? t("review.dateUnknown")}</span>
          {reason ? <span>{reason}</span> : null}
          {receipt.confidence && receipt.confidence !== "high" ? <span className="receipt__low">{t("review.lowConfidence")}</span> : null}
        </span>
      </button>
      {receipt.amount_cents !== null ? (
        <span className={`receipt__amount numeric ${mismatch ? "receipt__amount--mismatch" : ""}`}>
          {formatMoney(receipt.amount_cents, receipt.currency, i18n.language)}
        </span>
      ) : null}
      <span className="receipt__actions">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={`icon ${action.tone ? `icon--${action.tone}` : ""}`}
            aria-label={action.label}
            title={action.label}
            onClick={action.onClick}
            disabled={action.disabled}
          >
            <Icon name={action.icon} size={14} className={action.spinning ? "spin" : undefined} />
          </button>
        ))}
      </span>
    </li>
  );
}
