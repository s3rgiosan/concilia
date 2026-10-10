import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { menuState, runMenuCommand, type RejectKind, type ReviewAvailability, type ReviewCommands } from "../../review/commands";
import { isPreview } from "../preview";
import { onMenu, setMenu, setMenuState, subscribe } from "../tauri";
import { useLatest } from "./useLatest";

/** What the main window knows that decides which menu items are enabled and how they read. */
export interface MenuModel {
  /** False before setup: only Settings, Check for Updates and Help work. */
  configured: boolean;
  sidebarShown: boolean;
  inspectorShown: boolean;
  /** What Reject does for the selected transaction, which names its menu item. */
  rejectKind: RejectKind;
  /** The month is shown as statements to add and reconcile, and no run is going. */
  acceptsStatements: boolean;
  /** The month has statements added or transactions to reconcile. */
  canReconcile: boolean;
  /** The month has a match result, so it opens in the review. */
  hasResult: boolean;
  running: boolean;
  /** What the open review can run, or null when no review is shown. */
  reviewCan: ReviewAvailability | null;
}

/** The month-level actions the menu runs. */
export interface MenuActions {
  newMonth: () => void;
  addStatements: () => void;
  reconcile: () => void;
  rerun: () => void;
  openReport: () => void;
  revealPeriod: () => void;
  toggleSidebar: () => void;
}

/** Items that work before the app is set up. */
const ALWAYS_ENABLED = ["settings", "check_updates", "help"];

const MONTH_IDS = ["new_month", "add_statements", "reconcile", "rerun", "open_report", "reveal_period", "toggle_sidebar"];

/** Labels that are plain translations of their key. */
const LABEL_KEYS = [
  "menu_file",
  "menu_edit",
  "menu_view",
  "menu_month",
  "menu_transaction",
  "menu_go",
  "menu_window",
  "menu_help",
  "about",
  "services",
  "hide",
  "hide_others",
  "show_all",
  "quit",
  "cut",
  "copy",
  "paste",
  "select_all",
  "minimize",
  "zoom",
  "close_window",
  "settings",
  "check_updates",
  "new_month",
  "add_statements",
  "export_report",
  "open_report",
  "reveal_period",
  "undo",
  "redo",
  "find",
  "filter_all",
  "filter_review",
  "filter_unmatched",
  "filter_matched",
  "reconcile",
  "scan",
  "rerun",
  "finalize",
  "accept",
  "no_receipt",
  "no_receipt_bank_fee",
  "no_receipt_salary",
  "no_receipt_transfer",
  "no_receipt_refund",
  "no_receipt_no_receipt",
  "rescan",
  "quick_look",
  "open_in_preview",
  "next_pending",
  "previous_pending",
  "help",
];

const NO_REVIEW: ReviewAvailability = {
  accept: false,
  reject: false,
  noReceipt: false,
  rescan: false,
  quickLook: false,
  openInPreview: false,
  nextPending: false,
  previousPending: false,
  undo: false,
  redo: false,
  setFilter: false,
  focusSearch: false,
  toggleInspector: false,
  scan: false,
  exportReport: false,
  finalize: false,
};

/** Every item the frontend enables or disables, all off. */
function allOff(): Record<string, boolean> {
  const ids = [...ALWAYS_ENABLED, ...MONTH_IDS, ...Object.keys(menuState(NO_REVIEW))];
  return Object.fromEntries(ids.map((id) => [id, false]));
}

/** Which items are enabled for `model`, by id. */
export function menuEnabled(model: MenuModel): Record<string, boolean> {
  const enabled = allOff();
  for (const id of ALWAYS_ENABLED) {
    enabled[id] = true;
  }
  if (!model.configured) {
    return enabled;
  }
  return {
    ...enabled,
    new_month: true,
    add_statements: model.acceptsStatements,
    reconcile: model.acceptsStatements && model.canReconcile,
    rerun: model.hasResult && !model.running,
    open_report: model.hasResult,
    reveal_period: true,
    toggle_sidebar: true,
    ...menuState(model.reviewCan ?? NO_REVIEW),
  };
}

/** True when keyboard focus is in a field that edits text. */
function inTextField(): boolean {
  const element = document.activeElement;
  if (element instanceof HTMLTextAreaElement) {
    return true;
  }
  if (element instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "submit", "reset", "file", "range", "color", "image"].includes(element.type);
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

/**
 * Keeps the native menu bar in step with the main window: sends the localized labels when the
 * language or the sidebar and inspector state change, sends which items are enabled, and runs
 * the items the user chooses. Does nothing in the browser preview.
 */
export function useMenu(model: MenuModel, actions: MenuActions, reviewCommands: RefObject<ReviewCommands | null>) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const { sidebarShown, inspectorShown, rejectKind } = model;

  const labels = useMemo(() => {
    const result: Record<string, string> = {};
    for (const key of LABEL_KEYS) {
      result[key] = t(`menu.${key}`);
    }
    result.toggle_sidebar = t(sidebarShown ? "menu.hide_sidebar" : "menu.show_sidebar");
    result.toggle_inspector = t(inspectorShown ? "menu.hide_inspector" : "menu.show_inspector");
    result.reject = t(rejectKind === "noneOfThese" ? "menu.reject_review" : "menu.reject");
    return result;
    // The language is a dependency because `t` keeps its identity while the language changes.
  }, [t, language, sidebarShown, inspectorShown, rejectKind]);

  const enabled = menuEnabled(model);
  const enabledKey = JSON.stringify(enabled);

  /** Menu calls run one after another, so a state update never lands before the labels it follows. */
  const queue = useRef<Promise<void>>(Promise.resolve());
  const send = useCallback((call: () => Promise<void>) => {
    queue.current = queue.current.then(call).catch((e) => console.error("could not update the menu", e));
  }, []);

  useEffect(() => {
    if (!isPreview()) {
      send(() => setMenu(labels));
    }
  }, [labels, send]);

  useEffect(() => {
    if (!isPreview()) {
      send(() => setMenuState(JSON.parse(enabledKey) as Record<string, boolean>));
    }
  }, [enabledKey, labels, send]);

  const latestModel = useLatest(model);
  const latestActions = useLatest(actions);
  useEffect(() => {
    if (isPreview()) {
      return;
    }
    return subscribe(
      onMenu((id) => {
        const current = latestModel.current;
        const monthActions = latestActions.current;

        if ((id === "undo" || id === "redo") && inTextField()) {
          document.execCommand(id);
          return;
        }
        const sheetOpen = document.querySelector(".sheet-backdrop") !== null;
        const quickLookOpen = document.querySelector(".quicklook-backdrop") !== null;
        if (sheetOpen || (quickLookOpen && id !== "quick_look")) {
          return;
        }
        if (!current.configured && !ALWAYS_ENABLED.includes(id)) {
          return;
        }
        if (MONTH_IDS.includes(id) && menuEnabled(current)[id] !== true) {
          return;
        }
        switch (id) {
          case "new_month":
            monthActions.newMonth();
            return;
          case "add_statements":
            monthActions.addStatements();
            return;
          case "reconcile":
            monthActions.reconcile();
            return;
          case "rerun":
            monthActions.rerun();
            return;
          case "open_report":
            monthActions.openReport();
            return;
          case "reveal_period":
            monthActions.revealPeriod();
            return;
          case "toggle_sidebar":
            monthActions.toggleSidebar();
            return;
          default:
            break;
        }
        const commands = reviewCommands.current;
        if (commands) {
          runMenuCommand(commands, id);
        }
      }),
    );
  }, [latestModel, latestActions, reviewCommands]);
}
