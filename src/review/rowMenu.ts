import type { TFunction } from "i18next";
import type { MenuEntry } from "../lib/popUpMenu";
import { rejectMenuLabel } from "../lib/menuCommands";
import { reasonLabel, reasonName } from "../lib/reasons";
import { getRules, saveRules, type ReceiptMeta, type Reason, type Rule, type Transaction } from "../lib/tauri";
import { rejectKindOf } from "./commands";
import { noReceipt, unmatch, type Decision } from "./decisions";
import { isNoReceipt } from "./effective";
import type { Notice } from "./notices";
import { rowReceipts, type ListRow } from "./rows";

/** What the context menu of a row needs to know about the review, and what it can ask it to do. */
export interface RowMenuContext {
  t: TFunction;
  /** The UI language, which names the reasons. */
  language: string;
  /** The no-receipt reasons, in menu order. */
  reasons: readonly Reason[];
  /** The month is finalized. */
  applied: boolean;
  /** Decisions can change: the month is not finalized and nothing else runs. */
  decidable: boolean;
  selectedId: string | null;
  /** The receipt focused in the details column. */
  focused: ReceiptMeta | null;
  pool: ReceiptMeta[];
  claimed: Set<string>;
  /** The ids of the transactions with a pending decision. */
  edited: Set<string>;
  rescanning: Set<string>;
  selectRow: (row: ListRow) => void;
  showQuickLook: () => void;
  open: (receipt: ReceiptMeta) => void;
  rescan: (receipt: ReceiptMeta, reimbursement: boolean) => void;
  acceptReceipt: (tx: Transaction, receipt: ReceiptMeta) => void;
  decide: (tx: Transaction, decision: Decision) => void;
  setNotice: (notice: Notice) => void;
  onError: (e: unknown) => void;
}

/**
 * Adds a rule from a decision: the receipt's vendor to the transaction's description, or, with
 * `noReceipt`, the transaction's description to the no-receipt reason with that id.
 */
export function addRule(
  vendor: string,
  description: string,
  ctx: Pick<RowMenuContext, "t" | "setNotice" | "onError">,
  noReceipt?: string,
) {
  const { t, setNotice, onError } = ctx;
  getRules()
    .then((rules) => {
      const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
      const exists = rules.some(
        (r) => r.noReceipt === noReceipt && same(r.receiptVendor, vendor) && same(r.transactionDescription, description),
      );
      if (exists) {
        setNotice({ tone: "info", text: t("review.rule.exists") });
        return;
      }
      const id = crypto.randomUUID();
      const rule: Rule = noReceipt
        ? { id, receiptVendor: "", transactionDescription: description, noReceipt }
        : { id, receiptVendor: vendor, transactionDescription: description };
      return saveRules([...rules, rule]).then(() => setNotice({ tone: "success", text: t("review.rule.added") }));
    })
    .catch(onError);
}

/**
 * The rule offered for a transaction the user decided on: Always Match when it is matched to a
 * receipt with a vendor, Always Mark when it needs no receipt. Null otherwise.
 */
export function ruleEntry(tx: Transaction, ctx: RowMenuContext): MenuEntry | null {
  if (!ctx.edited.has(tx.id) || tx.status !== "MATCHED") {
    return null;
  }
  if (isNoReceipt(tx.notes)) {
    const reason = tx.notes;
    if (!ctx.reasons.some((r) => r.id === reason)) {
      return null;
    }
    return {
      label: ctx.t("review.rule.alwaysNoReceipt", { description: tx.description, reason: reasonLabel(ctx.reasons, reason, ctx.language) }),
      onSelect: () => addRule("", tx.description, ctx, reason),
    };
  }
  const vendor = tx.receipt_meta[0]?.vendor?.trim();
  if (!vendor) {
    return null;
  }
  return { label: ctx.t("review.rule.alwaysMatch", { vendor, description: tx.description }), onSelect: () => addRule(vendor, tx.description, ctx) };
}

/** The commands of a row's context menu, for that row and the receipt it shows. */
export function rowMenu(row: ListRow, ctx: RowMenuContext): MenuEntry[] {
  const { t, applied, decidable, decide } = ctx;
  const isSelected = row.id === ctx.selectedId;
  const shown = isSelected ? ctx.focused : (rowReceipts(row, ctx.pool, ctx.claimed)[0] ?? null);
  const look: MenuEntry[] = [
    {
      label: t("menu.quick_look"),
      onSelect: () => {
        ctx.selectRow(row);
        ctx.showQuickLook();
      },
      disabled: !shown?.rel_path,
    },
    { label: t("menu.open_in_preview"), onSelect: () => shown && ctx.open(shown), disabled: !shown?.rel_path },
  ];
  if (row.kind === "reimbursement") {
    return [
      {
        label: t("menu.rescan"),
        onSelect: () => ctx.rescan(row.receipt, true),
        disabled: applied || !row.receipt.rel_path || ctx.rescanning.has(row.receipt.file),
      },
      "separator",
      ...look,
    ];
  }
  const { tx } = row;
  const rule = applied ? null : ruleEntry(tx, ctx);
  return [
    { label: t("menu.accept"), onSelect: () => shown && ctx.acceptReceipt(tx, shown), disabled: !decidable || tx.status === "MATCHED" || !shown },
    {
      label: t(rejectMenuLabel(rejectKindOf(tx))),
      onSelect: () => decide(tx, unmatch()),
      disabled: !decidable || tx.status === "UNMATCHED",
    },
    {
      label: t("menu.no_receipt"),
      disabled: !decidable || tx.status === "MATCHED",
      submenu: ctx.reasons.map((reason) => ({ label: reasonName(reason, ctx.language), onSelect: () => decide(tx, noReceipt(reason.id)) })),
    },
    ...(rule ? (["separator", rule] as MenuEntry[]) : []),
    "separator",
    ...look,
  ];
}
