// The review's commands, which the toolbar, the keyboard and the app menu run.

import { FILTERS, NO_RECEIPT_CATEGORIES, type Filter, type NoReceiptCategory } from "./effective";

export const REVIEW_COMMANDS = [
  "accept",
  "reject",
  "noReceipt",
  "rescan",
  "quickLook",
  "openInPreview",
  "nextPending",
  "previousPending",
  "undo",
  "redo",
  "setFilter",
  "focusSearch",
  "scan",
  "exportReport",
  "finalize",
] as const;

/**
 * What Reject does for the selected transaction: None of These for REVIEW, Remove Match for a
 * MATCHED one with a receipt, and Needs a Receipt for one marked as needing none.
 */
export type RejectKind = "noneOfThese" | "removeMatch" | "needsReceipt";

export type ReviewCommand = (typeof REVIEW_COMMANDS)[number];

/** Whether each command can run now. */
export type ReviewAvailability = Record<ReviewCommand, boolean>;

/**
 * The review's commands. Each acts on the selected row and its focused receipt and does nothing
 * when `can` says it is unavailable.
 */
export interface ReviewCommands {
  /** Accepts the focused candidate of a REVIEW transaction, or assigns it to an UNMATCHED one. */
  accept: () => void;
  /** Sends the selected transaction back to UNMATCHED, as `RejectKind` names it. */
  reject: () => void;
  noReceipt: (category: NoReceiptCategory) => void;
  /** Reads the focused receipt again. */
  rescan: () => void;
  /** Shows or hides the focused receipt enlarged. */
  quickLook: () => void;
  openInPreview: () => void;
  nextPending: () => void;
  previousPending: () => void;
  undo: () => void;
  redo: () => void;
  setFilter: (filter: Filter) => void;
  focusSearch: () => void;
  /** Scans for new receipts. */
  scan: () => void;
  exportReport: () => void;
  /** Asks to finalize the month. */
  finalize: () => void;
  can: ReviewAvailability;
}

const FILTER_MENU: Record<string, Filter> = Object.fromEntries(FILTERS.map((filter) => [`filter_${filter}`, filter]));
const NO_RECEIPT_MENU: Record<string, NoReceiptCategory> = Object.fromEntries(
  NO_RECEIPT_CATEGORIES.map((category) => [`no_receipt_${category}`, category]),
);

/** The command a menu item (an id from src-tauri/src/menu.rs) runs in the review, or null. */
export function menuCommand(id: string): ReviewCommand | null {
  if (id in FILTER_MENU) {
    return "setFilter";
  }
  if (id in NO_RECEIPT_MENU || id === "no_receipt") {
    return "noReceipt";
  }
  switch (id) {
    case "accept":
    case "reject":
    case "rescan":
    case "undo":
    case "redo":
    case "scan":
    case "finalize":
      return id;
    case "quick_look":
      return "quickLook";
    case "open_in_preview":
      return "openInPreview";
    case "next_pending":
      return "nextPending";
    case "previous_pending":
      return "previousPending";
    case "find":
      return "focusSearch";
    case "export_report":
      return "exportReport";
    default:
      return null;
  }
}

/** Runs the command of a menu item. Returns whether the review handles the item. */
export function runMenuCommand(commands: ReviewCommands, id: string): boolean {
  const command = menuCommand(id);
  if (command === null) {
    return false;
  }
  if (!commands.can[command]) {
    return true;
  }
  switch (command) {
    case "setFilter":
      commands.setFilter(FILTER_MENU[id]);
      break;
    case "noReceipt":
      if (id in NO_RECEIPT_MENU) {
        commands.noReceipt(NO_RECEIPT_MENU[id]);
      }
      break;
    default:
      commands[command]();
      break;
  }
  return true;
}

/** Every menu item the review handles, with whether it is enabled, for `set_menu_state`. */
export function menuState(can: ReviewAvailability): Record<string, boolean> {
  const ids = [
    "accept",
    "reject",
    "no_receipt",
    ...Object.keys(NO_RECEIPT_MENU),
    "rescan",
    "quick_look",
    "open_in_preview",
    "next_pending",
    "previous_pending",
    "undo",
    "redo",
    ...Object.keys(FILTER_MENU),
    "find",
    "scan",
    "export_report",
    "finalize",
  ];
  return Object.fromEntries(ids.map((id) => [id, can[menuCommand(id) as ReviewCommand]]));
}
