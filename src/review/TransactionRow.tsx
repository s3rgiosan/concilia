import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { ActionPopUpButton } from "../components/PopUpButton";
import { formatMoney } from "../lib/money";
import type { ReceiptMeta, Transaction } from "../lib/tauri";
import { amountMismatch, byAmountProximity, isNoReceipt, NO_RECEIPT_CATEGORIES, type NoReceiptCategory } from "./effective";
import { matchReason, noReceiptLabel } from "./notes";
import { ReceiptRow, type ReceiptAction } from "./ReceiptRow";

const STATUS_DOT = { MATCHED: "dot--green", REVIEW: "dot--orange", UNMATCHED: "dot--red" } as const;

export interface RowHandlers {
  onConfirm: (tx: Transaction, receipt?: ReceiptMeta) => void;
  onUnmatch: (tx: Transaction) => void;
  onAssign: (tx: Transaction, receipt: ReceiptMeta) => void;
  onNoReceipt: (tx: Transaction, category: NoReceiptCategory) => void;
  onRescan: (receipt: ReceiptMeta) => void;
  onPreview: (tx: Transaction, receipt: ReceiptMeta) => void;
}

/** A transaction with its receipts and the decisions available for it. */
export function TransactionRow({
  tx,
  expanded,
  onToggle,
  pool,
  claimed,
  rescanning,
  selectedFile,
  handlers,
}: {
  tx: Transaction;
  expanded: boolean;
  onToggle: () => void;
  /** Receipts free for assignment. */
  pool: ReceiptMeta[];
  /** Receipts bound to a MATCHED transaction. */
  claimed: Set<string>;
  rescanning: Set<string>;
  selectedFile: string | null;
  handlers: RowHandlers;
}) {
  const { t, i18n } = useTranslation();
  const reason = matchReason(tx.notes, t);

  function rescanAction(receipt: ReceiptMeta): ReceiptAction {
    return {
      id: "rescan",
      label: t("review.actions.rescan"),
      icon: "refresh",
      onClick: () => handlers.onRescan(receipt),
      disabled: rescanning.has(receipt.file) || !receipt.rel_path,
      spinning: rescanning.has(receipt.file),
    };
  }

  function receiptRow(receipt: ReceiptMeta, actions: ReceiptAction[], showReason: boolean) {
    return (
      <ReceiptRow
        key={receipt.file}
        receipt={receipt}
        reason={showReason ? reason : undefined}
        mismatch={amountMismatch(receipt, tx.abs_cents)}
        selected={selectedFile === receipt.file}
        onSelect={() => handlers.onPreview(tx, receipt)}
        actions={[rescanAction(receipt), ...actions]}
      />
    );
  }

  let body = null;
  switch (tx.status) {
    case "REVIEW": {
      const open = tx.receipt_meta.filter((m) => !claimed.has(m.file));
      if (open.length === 0) {
        // Every candidate went to another transaction: this one can only be sent back.
        body = (
          <li className="receipt">
            <span className="receipt__main receipt__main--static muted">{t("review.candidatesTaken")}</span>
            <span className="receipt__actions">
              <button
                type="button"
                className="icon icon--reject"
                aria-label={t("review.actions.reject")}
                title={t("review.actions.reject")}
                onClick={() => handlers.onUnmatch(tx)}
              >
                <Icon name="xmark" size={14} />
              </button>
            </span>
          </li>
        );
        break;
      }
      body = open.map((m) =>
          receiptRow(
            m,
            [
              { id: "accept", label: t("review.actions.accept"), icon: "check", tone: "accept", onClick: () => handlers.onConfirm(tx, m) },
              { id: "reject", label: t("review.actions.reject"), icon: "xmark", tone: "reject", onClick: () => handlers.onUnmatch(tx) },
            ],
            true,
          ),
        );
      break;
    }
    case "UNMATCHED": {
      const candidates = byAmountProximity(pool, tx.abs_cents);
      body =
        candidates.length > 0 ? (
          candidates.map((r) =>
            receiptRow(r, [{ id: "assign", label: t("review.actions.assign"), icon: "check", tone: "accept", onClick: () => handlers.onAssign(tx, r) }], false),
          )
        ) : (
          <li className="receipt receipt--empty muted">{t("review.noCandidates")}</li>
        );
      break;
    }
    case "MATCHED":
    default: {
      const dispute: ReceiptAction = { id: "dispute", label: t("review.actions.dispute"), icon: "minus", onClick: () => handlers.onUnmatch(tx) };
      if (isNoReceipt(tx.notes) || tx.receipt_meta.length === 0) {
        body = (
          <li className="receipt">
            <span className="receipt__main receipt__main--static">
              <span className="receipt__vendor">{isNoReceipt(tx.notes) ? noReceiptLabel(tx.notes, t) : t("review.noReceipt")}</span>
            </span>
            <span className="receipt__actions">
              <button type="button" className="icon" aria-label={dispute.label} title={dispute.label} onClick={dispute.onClick}>
                <Icon name="minus" size={14} />
              </button>
            </span>
          </li>
        );
      } else {
        body = tx.receipt_meta.map((m) => receiptRow(m, [dispute], true));
      }
      break;
    }
  }

  const income = tx.amount_cents > 0;
  return (
    <li className={`tx tx--${tx.status.toLowerCase()}`}>
      <button type="button" className="tx__header" aria-expanded={expanded} onClick={onToggle}>
        <Icon name="disclosure" size={10} className={`tx__chevron ${expanded ? "tx__chevron--open" : ""}`} />
        <span className="tx__date numeric muted">{tx.date}</span>
        <span className={`dot ${STATUS_DOT[tx.status]}`} aria-hidden="true" />
        <span className="visually-hidden">{t(`review.filters.${tx.status.toLowerCase()}`)}</span>
        <span className="tx__description">{tx.description}</span>
        <span className={`tx__amount numeric ${income ? "tx__amount--income" : ""}`}>
          {formatMoney(tx.amount_cents, "EUR", i18n.language)}
        </span>
      </button>
      {expanded ? (
        <div className="tx__body">
          <ul className="tx__receipts">{body}</ul>
          {tx.status === "UNMATCHED" ? (
            <div className="tx__footer">
              <ActionPopUpButton
                label={t("review.noReceiptMenu")}
                actions={NO_RECEIPT_CATEGORIES.map((category) => ({
                  label: noReceiptLabel(category, t),
                  onSelect: () => handlers.onNoReceipt(tx, category),
                }))}
              />
              <span className="muted">{t("review.noReceiptMenu")}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
