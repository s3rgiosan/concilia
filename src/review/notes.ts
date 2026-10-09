import type { TFunction } from "i18next";
import { isNoReceipt, type NoReceiptCategory } from "./effective";

const NO_RECEIPT_KEYS: Record<NoReceiptCategory, string> = {
  bank_fee: "review.noReceiptCategories.bankFee",
  salary: "review.noReceiptCategories.salary",
  transfer: "review.noReceiptCategories.transfer",
  refund: "review.noReceiptCategories.refund",
  no_receipt: "review.noReceiptCategories.noReceipt",
};

export function noReceiptLabel(category: NoReceiptCategory, t: TFunction): string {
  return t(NO_RECEIPT_KEYS[category]);
}

const COUNTED: [RegExp, string][] = [
  [/^(\d+) receipts match name\+amount \(unknown currency\)$/, "review.matchReason.multipleNameAmountUnknownCurrency"],
  [/^(\d+) receipts match name\+amount$/, "review.matchReason.multipleNameAmount"],
  [/^(\d+) receipts match amount \(unknown currency\)$/, "review.matchReason.multipleAmountUnknownCurrency"],
  [/^(\d+) receipts match amount$/, "review.matchReason.multipleAmount"],
  [/^(\d+) receipts match by filename$/, "review.matchReason.multipleFilename"],
];

/** Why a transaction has its status, from the matcher's note code. Unknown codes are shown as they are. */
export function matchReason(notes: string, t: TFunction): string {
  switch (notes) {
    case "":
      return "";
    case "bank_fee":
      return t("review.matchReason.bankFeeAuto");
    case "name_amount_match":
      return t("review.matchReason.nameAmountMatch");
    case "name_amount_date_match":
      return t("review.matchReason.nameAmountDateMatch");
    case "amount_match":
      return t("review.matchReason.amountMatch");
    case "amount_date_match":
      return t("review.matchReason.amountDateMatch");
    case "unknown_currency_match":
      return t("review.matchReason.unknownCurrencyMatch");
    case "manual_match":
      return t("review.matchReason.manualMatch");
    default:
      break;
  }
  if (isNoReceipt(notes)) {
    return noReceiptLabel(notes, t);
  }
  const detail = notes.match(/\(([^)]+)\)/)?.[1] ?? "";
  if (notes.startsWith("fx_match")) {
    return t("review.matchReason.fxMatch", { detail });
  }
  if (notes.startsWith("filename_match")) {
    return t("review.matchReason.filenameMatch");
  }
  if (notes.startsWith("rule_match")) {
    return t("review.matchReason.ruleMatch", { vendor: detail });
  }
  const fx = notes.match(/^(\d+) fx receipts within (.+)$/);
  if (fx) {
    return t("review.matchReason.multipleFx", { count: Number(fx[1]), tolerance: fx[2] });
  }
  for (const [pattern, key] of COUNTED) {
    const m = notes.match(pattern);
    if (m) {
      return t(key, { count: Number(m[1]) });
    }
  }
  return notes;
}
