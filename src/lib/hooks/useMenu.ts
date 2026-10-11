import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { menuState, rejectMenuLabel, runMenuCommand, type ReviewAvailability, type ReviewCommands } from "../menuCommands";
import { isTextField } from "../popUpMenu";
import { isPreview } from "../preview";
import type { ReviewMenuStore } from "../reviewMenu";
import { shallowEqual } from "../shallowEqual";
import { onMenu, setMenu, setMenuItemText, setMenuState, subscribe } from "../tauri";
import { useLatest } from "./useLatest";
import { useShallowStable } from "./useShallowStable";

/** What the main window knows that decides which menu items are enabled and how they read. */
export interface MenuModel {
  /** False before setup: only Settings, Check for Updates and Help work. */
  configured: boolean;
  sidebarShown: boolean;
  /** The month is shown as statements to add and reconcile, and no run is going. */
  acceptsStatements: boolean;
  /** The month has receipts, and statements added or transactions to reconcile. */
  canReconcile: boolean;
  /** The month has a match result, so it opens in the review. */
  hasResult: boolean;
  running: boolean;
  /** What the open review can run, or null when no review is shown. */
  reviewCan: ReviewAvailability | null;
}

/** `MenuModel` for the hook: the review's availability comes from the review's store. */
export type MenuInputs = Omit<MenuModel, "reviewCan"> & {
  /** A review is shown, so its availability in the store applies. */
  reviewShown: boolean;
};

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
  "bring_all_to_front",
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
  "filter_pending",
  "filter_matched",
  "filter_all",
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
  scan: false,
  exportReport: false,
  finalize: false,
  addStatements: false,
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
    add_statements: model.acceptsStatements || model.reviewCan?.addStatements === true,
    reconcile: model.acceptsStatements && model.canReconcile,
    rerun: model.hasResult && !model.running,
    open_report: model.hasResult,
    reveal_period: true,
    toggle_sidebar: true,
    ...menuState(model.reviewCan ?? NO_REVIEW),
  };
}

/**
 * Keeps the native menu bar in step with the main window: sends the localized labels when the
 * language or the sidebar change, renames Reject as the selected transaction changes what it does,
 * sends which items are enabled, and runs the items the user chooses. The review's availability and
 * Reject kind are read from `review` without rendering the caller. Does nothing in the browser
 * preview.
 */
export function useMenu(inputs: MenuInputs, actions: MenuActions, reviewCommands: RefObject<ReviewCommands | null>, review: ReviewMenuStore) {
  const { t } = useTranslation();
  const { sidebarShown } = inputs;

  const menu = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const key of LABEL_KEYS) {
      labels[key] = t(`menu.${key}`);
    }
    labels.toggle_sidebar = t(sidebarShown ? "menu.hide_sidebar" : "menu.show_sidebar");
    const rejectKind = review.get().rejectKind;
    labels.reject = t(rejectMenuLabel(rejectKind));
    return { labels, rejectKind };
  }, [t, sidebarShown, review]);

  /** Menu calls run one after another, so a state update never lands before the labels it follows. */
  const queue = useRef<Promise<void>>(Promise.resolve());
  const send = useCallback((call: () => Promise<void>) => {
    queue.current = queue.current.then(call).catch((e) => console.error("could not update the menu", e));
  }, []);

  const latestModel = useLatest(inputs);
  /** The model with the review's availability from the store. */
  const modelNow = useCallback((): MenuModel => {
    const current = latestModel.current;
    return { ...current, reviewCan: current.reviewShown ? review.get().can : null };
  }, [latestModel, review]);

  /** The Reject kind whose text the menu shows. */
  const sentKind = useRef(menu.rejectKind);
  const sentState = useRef<Record<string, boolean> | null>(null);

  const syncState = useCallback(
    (force: boolean) => {
      const next = menuEnabled(modelNow());
      if (!force && sentState.current && shallowEqual(sentState.current, next)) {
        return;
      }
      sentState.current = next;
      send(() => setMenuState(next));
    },
    [modelNow, send],
  );

  const syncReject = useCallback(() => {
    const kind = review.get().rejectKind;
    if (kind !== sentKind.current) {
      sentKind.current = kind;
      send(() => setMenuItemText("reject", t(rejectMenuLabel(kind))));
    }
  }, [review, send, t]);

  useEffect(() => {
    if (isPreview()) {
      return;
    }
    sentKind.current = menu.rejectKind;
    send(() => setMenu(menu.labels));
    syncReject();
    syncState(true);
  }, [menu, send, syncReject, syncState]);

  const stableInputs = useShallowStable(inputs);
  useEffect(() => {
    if (!isPreview()) {
      syncState(false);
    }
  }, [stableInputs, syncState]);

  useEffect(() => {
    if (isPreview()) {
      return;
    }
    return review.subscribe(() => {
      syncReject();
      syncState(false);
    });
  }, [review, syncReject, syncState]);

  const latestActions = useLatest(actions);
  useEffect(() => {
    if (isPreview()) {
      return;
    }
    return subscribe(
      onMenu((id) => {
        const current = modelNow();
        const monthActions = latestActions.current;

        if ((id === "undo" || id === "redo") && isTextField(document.activeElement)) {
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
  }, [modelNow, latestActions, reviewCommands]);
}
