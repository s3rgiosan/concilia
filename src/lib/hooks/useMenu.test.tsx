// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import menuSource from "../../../src-tauri/src/menu.rs?raw";
import { REVIEW_COMMANDS, type ReviewAvailability, type ReviewCommands } from "../../review/commands";
import { onMenu, setMenu, setMenuState } from "../tauri";
import { menuEnabled, useMenu, type MenuActions, type MenuModel } from "./useMenu";

vi.mock("../tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tauri")>()),
  onMenu: vi.fn(),
  setMenu: vi.fn(),
  setMenuState: vi.fn(),
}));

const mocks = vi.hoisted(() => ({ preview: false }));
vi.mock("../preview", () => ({ isPreview: () => mocks.preview }));

let choose: (id: string) => void;

function availability(value: boolean): ReviewAvailability {
  return Object.fromEntries(REVIEW_COMMANDS.map((command) => [command, value])) as ReviewAvailability;
}

const STATEMENTS_SCREEN: MenuModel = {
  configured: true,
  sidebarShown: true,
  rejectKind: "removeMatch",
  acceptsStatements: true,
  canReconcile: true,
  hasResult: false,
  running: false,
  reviewCan: null,
};

const REVIEW_SCREEN: MenuModel = {
  ...STATEMENTS_SCREEN,
  acceptsStatements: false,
  canReconcile: false,
  hasResult: true,
  reviewCan: availability(true),
};

const UNCONFIGURED: MenuModel = { ...STATEMENTS_SCREEN, configured: false, acceptsStatements: false, canReconcile: false };

function makeActions(): { [K in keyof MenuActions]: ReturnType<typeof vi.fn> } {
  return {
    newMonth: vi.fn(),
    addStatements: vi.fn(),
    reconcile: vi.fn(),
    rerun: vi.fn(),
    openReport: vi.fn(),
    revealPeriod: vi.fn(),
    toggleSidebar: vi.fn(),
  };
}

function makeCommands(can: ReviewAvailability = availability(true)): ReviewCommands {
  return {
    accept: vi.fn(),
    reject: vi.fn(),
    noReceipt: vi.fn(),
    rescan: vi.fn(),
    quickLook: vi.fn(),
    openInPreview: vi.fn(),
    nextPending: vi.fn(),
    previousPending: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    setFilter: vi.fn(),
    focusSearch: vi.fn(),
    scan: vi.fn(),
    exportReport: vi.fn(),
    finalize: vi.fn(),
    can,
  };
}

function setup(model: MenuModel, commands: ReviewCommands | null = null) {
  const actions = makeActions();
  const ref = createRef<ReviewCommands | null>() as RefObject<ReviewCommands | null>;
  ref.current = commands;
  const view = renderHook(({ m }: { m: MenuModel }) => useMenu(m, actions as unknown as MenuActions, ref), { initialProps: { m: model } });
  return { actions, ...view };
}

/** The labels from the last `setMenu` call. */
function labels(): Record<string, string> {
  const calls = vi.mocked(setMenu).mock.calls;
  return calls[calls.length - 1][0];
}

function lastState(): Record<string, boolean> {
  const calls = vi.mocked(setMenuState).mock.calls;
  return calls[calls.length - 1][0];
}

async function flush() {
  await act(async () => undefined);
}

beforeEach(() => {
  mocks.preview = false;
  vi.mocked(setMenu).mockResolvedValue(undefined);
  vi.mocked(setMenuState).mockResolvedValue(undefined);
  vi.mocked(onMenu).mockImplementation((handler) => {
    choose = handler;
    return Promise.resolve(() => undefined);
  });
});

afterEach(async () => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
});

/** Every label key the backend accepts, read from the Rust constants. */
function backendKeys(): string[] {
  const keys = [...menuSource.matchAll(/^pub const (\w+): &str = "(\w+)";$/gm)].filter(([, name]) => name !== "MENU_EVENT" && name !== "HELP_URL");
  return keys.map(([, , value]) => value);
}

describe("labels", () => {
  it("covers every key the backend accepts, in English", async () => {
    setup(STATEMENTS_SCREEN);
    await flush();
    const sent = labels();
    expect(Object.keys(sent).sort()).toEqual(expect.arrayContaining(backendKeys().sort()));
    for (const key of backendKeys()) {
      expect(sent[key], key).toBeTruthy();
    }
    expect(sent).toMatchObject({
      menu_file: "File",
      new_month: "New Month…",
      about: "About {app}",
      hide: "Hide {app}",
      quit: "Quit {app}",
      accept: "Assign Receipt",
      reject: "Remove Match",
      rescan: "Read Receipt Again",
      find: "Find",
      toggle_sidebar: "Hide Sidebar",
      filter_pending: "To Decide",
    });
  });

  it("sends Portuguese labels and keeps {app} for the backend", async () => {
    await i18n.changeLanguage("pt");
    setup(STATEMENTS_SCREEN);
    await flush();
    expect(labels()).toMatchObject({
      menu_file: "Ficheiro",
      menu_edit: "Edição",
      menu_view: "Visualização",
      menu_window: "Janela",
      menu_help: "Ajuda",
      undo: "Desfazer",
      redo: "Refazer",
      cut: "Cortar",
      copy: "Copiar",
      paste: "Colar",
      select_all: "Selecionar tudo",
      minimize: "Minimizar",
      zoom: "Zoom",
      close_window: "Fechar janela",
      hide: "Ocultar {app}",
      hide_others: "Ocultar outros",
      show_all: "Mostrar tudo",
      quit: "Sair do {app}",
      about: "Acerca do {app}",
      services: "Serviços",
      toggle_sidebar: "Ocultar barra lateral",
    });
  });

  it("sends the labels again when the language changes", async () => {
    setup(STATEMENTS_SCREEN);
    await flush();
    expect(setMenu).toHaveBeenCalledTimes(1);
    await act(async () => {
      await i18n.changeLanguage("pt");
    });
    expect(setMenu).toHaveBeenCalledTimes(2);
    expect(labels().menu_file).toBe("Ficheiro");
  });

  it("names the sidebar toggle by its state", async () => {
    const { rerender } = setup({ ...STATEMENTS_SCREEN, sidebarShown: false });
    await flush();
    expect(labels()).toMatchObject({ toggle_sidebar: "Show Sidebar" });
    expect(labels()).not.toHaveProperty("toggle_inspector");
    rerender({ m: STATEMENTS_SCREEN });
    await flush();
    expect(labels()).toMatchObject({ toggle_sidebar: "Hide Sidebar" });
  });

  it("names the reject item by what it does to the selected transaction", async () => {
    const { rerender } = setup({ ...REVIEW_SCREEN, rejectKind: "noneOfThese" });
    await flush();
    expect(labels().reject).toBe("None of These");
    rerender({ m: { ...REVIEW_SCREEN, rejectKind: "needsReceipt" } });
    await flush();
    expect(labels().reject).toBe("Needs a Receipt");
    rerender({ m: REVIEW_SCREEN });
    await flush();
    expect(labels().reject).toBe("Remove Match");
    await act(async () => {
      await i18n.changeLanguage("pt");
    });
    expect(labels().reject).toBe("Remover associação");
  });

  it("sends the labels before the state", async () => {
    const order: string[] = [];
    vi.mocked(setMenu).mockImplementation(async () => {
      order.push("labels");
    });
    vi.mocked(setMenuState).mockImplementation(async () => {
      order.push("state");
    });
    setup(STATEMENTS_SCREEN);
    await flush();
    expect(order).toEqual(["labels", "state"]);
  });
});

describe("enabled items", () => {
  const ALWAYS = ["settings", "check_updates", "help"];

  it("allows only Settings, Check for Updates and Help before setup", async () => {
    setup(UNCONFIGURED);
    await flush();
    const state = lastState();
    for (const [id, on] of Object.entries(state)) {
      expect(on, id).toBe(ALWAYS.includes(id));
    }
    expect(Object.keys(state)).toEqual(expect.arrayContaining(["new_month", "accept", "export_report", "undo", "toggle_sidebar"]));
  });

  it("enables the statements screen's items and disables the review's", async () => {
    setup(STATEMENTS_SCREEN);
    await flush();
    const state = lastState();
    expect(state).toMatchObject({
      new_month: true,
      add_statements: true,
      reconcile: true,
      reveal_period: true,
      toggle_sidebar: true,
      rerun: false,
      open_report: false,
      accept: false,
      export_report: false,
      finalize: false,
      undo: false,
      find: false,
      filter_pending: false,
      filter_all: false,
      no_receipt_salary: false,
    });
  });

  it("keeps Reconcile off while there is nothing to reconcile", () => {
    expect(menuEnabled({ ...STATEMENTS_SCREEN, canReconcile: false })).toMatchObject({ add_statements: true, reconcile: false });
  });

  it("turns the statements items off while a run is going", () => {
    expect(menuEnabled({ ...STATEMENTS_SCREEN, acceptsStatements: false, running: true })).toMatchObject({
      add_statements: false,
      reconcile: false,
      new_month: true,
    });
  });

  it("enables the review's items from what the review can run", async () => {
    const can = { ...availability(false), accept: true, setFilter: true, focusSearch: true, scan: true };
    setup({ ...REVIEW_SCREEN, reviewCan: can });
    await flush();
    expect(lastState()).toMatchObject({
      add_statements: false,
      reconcile: false,
      rerun: true,
      open_report: true,
      reveal_period: true,
      accept: true,
      filter_pending: true,
      filter_matched: true,
      find: true,
      scan: true,
      reject: false,
      undo: false,
      finalize: false,
    });
  });

  it("turns Re-run off while a run is going", () => {
    expect(menuEnabled({ ...REVIEW_SCREEN, running: true }).rerun).toBe(false);
  });

  it("disables the review's items when no review is shown", () => {
    const state = menuEnabled({ ...REVIEW_SCREEN, reviewCan: null });
    expect(state).toMatchObject({ accept: false, export_report: false, find: false });
  });

  it("sends the state again when it changes", async () => {
    const { rerender } = setup(STATEMENTS_SCREEN);
    await flush();
    rerender({ m: REVIEW_SCREEN });
    await flush();
    expect(lastState()).toMatchObject({ rerun: true, add_statements: false, accept: true });
  });

  it("does not send an unchanged state again", async () => {
    const { rerender } = setup(STATEMENTS_SCREEN);
    await flush();
    rerender({ m: { ...STATEMENTS_SCREEN } });
    await flush();
    expect(setMenuState).toHaveBeenCalledTimes(1);
  });
});

describe("routing", () => {
  it.each([
    ["new_month", "newMonth"],
    ["rerun", "rerun"],
    ["open_report", "openReport"],
    ["reveal_period", "revealPeriod"],
    ["toggle_sidebar", "toggleSidebar"],
  ] as const)("sends %s to the main window", async (id, action) => {
    const { actions } = setup({ ...REVIEW_SCREEN }, makeCommands());
    await flush();
    act(() => choose(id));
    expect(actions[action]).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["add_statements", "addStatements"],
    ["reconcile", "reconcile"],
  ] as const)("sends %s to the main window on the statements screen", async (id, action) => {
    const { actions } = setup(STATEMENTS_SCREEN);
    await flush();
    act(() => choose(id));
    expect(actions[action]).toHaveBeenCalledTimes(1);
  });

  it("ignores month items that are disabled", async () => {
    const { actions } = setup(REVIEW_SCREEN, makeCommands());
    await flush();
    act(() => choose("add_statements"));
    act(() => choose("reconcile"));
    expect(actions.addStatements).not.toHaveBeenCalled();
    expect(actions.reconcile).not.toHaveBeenCalled();
  });

  it("ignores everything but the always-on items before setup", async () => {
    const { actions } = setup(UNCONFIGURED);
    await flush();
    act(() => choose("new_month"));
    act(() => choose("toggle_sidebar"));
    expect(actions.newMonth).not.toHaveBeenCalled();
    expect(actions.toggleSidebar).not.toHaveBeenCalled();
  });

  it.each([
    ["accept", "accept", []],
    ["reject", "reject", []],
    ["rescan", "rescan", []],
    ["quick_look", "quickLook", []],
    ["open_in_preview", "openInPreview", []],
    ["next_pending", "nextPending", []],
    ["previous_pending", "previousPending", []],
    ["undo", "undo", []],
    ["redo", "redo", []],
    ["find", "focusSearch", []],
    ["scan", "scan", []],
    ["export_report", "exportReport", []],
    ["finalize", "finalize", []],
    ["filter_pending", "setFilter", ["pending"]],
    ["filter_matched", "setFilter", ["matched"]],
    ["filter_all", "setFilter", ["all"]],
    ["no_receipt_bank_fee", "noReceipt", ["bank_fee"]],
    ["no_receipt_salary", "noReceipt", ["salary"]],
    ["no_receipt_transfer", "noReceipt", ["transfer"]],
    ["no_receipt_refund", "noReceipt", ["refund"]],
    ["no_receipt_no_receipt", "noReceipt", ["no_receipt"]],
  ] as const)("sends %s to the review", async (id, command, args) => {
    const commands = makeCommands();
    setup(REVIEW_SCREEN, commands);
    await flush();
    act(() => choose(id));
    expect(commands[command]).toHaveBeenCalledExactlyOnceWith(...args);
  });

  it("does not run a review command the review cannot run", async () => {
    const commands = makeCommands({ ...availability(true), accept: false });
    setup(REVIEW_SCREEN, commands);
    await flush();
    act(() => choose("accept"));
    expect(commands.accept).not.toHaveBeenCalled();
  });

  it("does nothing for Find when no review is shown", async () => {
    const { actions } = setup(STATEMENTS_SCREEN);
    await flush();
    expect(() => act(() => choose("find"))).not.toThrow();
    for (const action of Object.values(actions)) {
      expect(action).not.toHaveBeenCalled();
    }
  });

  it("ignores items the frontend does not handle", async () => {
    const commands = makeCommands();
    setup(REVIEW_SCREEN, commands);
    await flush();
    expect(() => act(() => choose("something_else"))).not.toThrow();
  });

  it("ignores items while a sheet is open", async () => {
    const commands = makeCommands();
    const { actions } = setup(REVIEW_SCREEN, commands);
    await flush();
    document.body.innerHTML = '<div class="sheet-backdrop"></div>';
    act(() => choose("accept"));
    act(() => choose("rerun"));
    expect(commands.accept).not.toHaveBeenCalled();
    expect(actions.rerun).not.toHaveBeenCalled();
  });

  it("lets Quick Look close itself and ignores the rest while it is open", async () => {
    const commands = makeCommands();
    setup(REVIEW_SCREEN, commands);
    await flush();
    document.body.innerHTML = '<div class="quicklook-backdrop"></div>';
    act(() => choose("next_pending"));
    act(() => choose("quick_look"));
    expect(commands.nextPending).not.toHaveBeenCalled();
    expect(commands.quickLook).toHaveBeenCalledTimes(1);
  });
});

describe("undo and redo in text fields", () => {
  let execCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    execCommand = vi.fn();
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true, writable: true });
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "execCommand");
  });

  function focusElement(html: string, selector: string) {
    document.body.innerHTML = html;
    (document.querySelector(selector) as HTMLElement).focus();
  }

  it.each([
    ["an input", '<input type="search" id="f" />'],
    ["a textarea", '<textarea id="f"></textarea>'],
    ["an input without a type", '<input id="f" />'],
  ])("edits the text of %s", async (_name, html) => {
    const commands = makeCommands();
    setup(REVIEW_SCREEN, commands);
    await flush();
    focusElement(html, "#f");
    act(() => choose("undo"));
    act(() => choose("redo"));
    expect(execCommand.mock.calls).toEqual([["undo"], ["redo"]]);
    expect(commands.undo).not.toHaveBeenCalled();
    expect(commands.redo).not.toHaveBeenCalled();
  });

  it("undoes text even when the review has nothing to undo", async () => {
    setup(REVIEW_SCREEN, makeCommands({ ...availability(true), undo: false }));
    await flush();
    focusElement('<input id="f" />', "#f");
    act(() => choose("undo"));
    expect(execCommand).toHaveBeenCalledWith("undo");
  });

  it("undoes a decision when focus is not in a text field", async () => {
    const commands = makeCommands();
    setup(REVIEW_SCREEN, commands);
    await flush();
    focusElement('<button id="f">Go</button>', "#f");
    act(() => choose("undo"));
    focusElement('<input type="checkbox" id="f" />', "#f");
    act(() => choose("redo"));
    expect(execCommand).not.toHaveBeenCalled();
    expect(commands.undo).toHaveBeenCalledTimes(1);
    expect(commands.redo).toHaveBeenCalledTimes(1);
  });
});

describe("environment", () => {
  it("does nothing in the browser preview", async () => {
    mocks.preview = true;
    setup(STATEMENTS_SCREEN);
    await flush();
    expect(setMenu).not.toHaveBeenCalled();
    expect(setMenuState).not.toHaveBeenCalled();
    expect(onMenu).not.toHaveBeenCalled();
  });

  it("logs a failed menu call and keeps sending", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(setMenu).mockRejectedValueOnce(new Error("no menu"));
    setup(STATEMENTS_SCREEN);
    await flush();
    expect(error).toHaveBeenCalled();
    expect(setMenuState).toHaveBeenCalledTimes(1);
  });

  it("stops listening on unmount", async () => {
    const unlisten = vi.fn();
    vi.mocked(onMenu).mockResolvedValue(unlisten);
    const { unmount } = setup(STATEMENTS_SCREEN);
    await flush();
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
