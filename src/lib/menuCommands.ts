// The review's command ids and types, which the toolbar, the keyboard and the app menu share.

import { REASON_MENU_PREFIX } from "./reasons";

/** The review list's filters. */
export const FILTERS = ["pending", "matched", "all"] as const;
export type Filter = (typeof FILTERS)[number];

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
  "addStatements",
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
  /** Marks the selected transaction as needing no receipt for the reason with this id. */
  noReceipt: (reason: string) => void;
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
  /** Picks bank statements to add to the month. The app menu runs it as a month item. */
  addStatements: () => void;
  /** Saves pending decisions. Resolves when the draft is stored and rejects when the save fails. */
  flush?: () => Promise<void>;
  can: ReviewAvailability;
}

const FILTER_MENU: Record<string, Filter> = Object.fromEntries(FILTERS.map((filter) => [`filter_${filter}`, filter]));

/** The command a menu item (an id from src-tauri/src/menu.rs) runs in the review, or null. */
export function menuCommand(id: string): ReviewCommand | null {
  if (id in FILTER_MENU) {
    return "setFilter";
  }
  if (id === "no_receipt" || id.startsWith(REASON_MENU_PREFIX)) {
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
      if (id.startsWith(REASON_MENU_PREFIX)) {
        commands.noReceipt(id.slice(REASON_MENU_PREFIX.length));
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

/** The menu label key of Reject for what it does to the selected transaction. */
export function rejectMenuLabel(kind: RejectKind): string {
  switch (kind) {
    case "noneOfThese":
      return "menu.reject_review";
    case "needsReceipt":
      return "menu.reject_no_receipt";
    case "removeMatch":
    default:
      return "menu.reject";
  }
}

/**
 * The review's commands with each one running only while `can` allows it, so the actions need no
 * guard of their own.
 */
export function guardCommands(can: ReviewAvailability, actions: Omit<ReviewCommands, "can">): ReviewCommands {
  const guarded = Object.fromEntries(
    REVIEW_COMMANDS.map((command) => [
      command,
      (...args: unknown[]) => {
        if (can[command]) {
          (actions[command] as (...a: unknown[]) => void)(...args);
        }
      },
    ]),
  );
  return { ...(guarded as Omit<ReviewCommands, "can">), can };
}
