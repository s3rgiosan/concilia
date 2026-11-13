// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ref } from "react";
import type { PopUpAction } from "../components/PopUpButton";
import type { ToolbarSlots } from "../components/Toolbar";
import type { ReviewCommands } from "../lib/menuCommands";
import { emptySummary, type Period } from "../lib/period";
import {
  createPeriod,
  getAppState,
  installUpdate,
  listPeriods,
  onBusyChanged,
  onMenu,
  onSettingsChanged,
  onUpdateCheckResult,
  onUpdateProgress,
  openReport,
  openSettings,
  pendingUpdate,
  periodSummary,
  pickStatements,
  requestAttention,
  reopenPeriod,
  revealPeriod,
  showAlert,
  setDockProgress,
  setMenu,
  setMenuState,
  setWindowTitle,
  startReconcile,
  type AppStateView,
  type PeriodSummary,
  type RunEvent,
  type RunHandle,
  type Summary,
  type UpdateCheckResult,
  type UpdateProgress,
} from "../lib/tauri";
import { deferred, makeSettings, makeView, nextFrame } from "../test/fixtures";
import { Main } from "./Main";

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  cancelRun: vi.fn(),
  createPeriod: vi.fn(),
  getAppState: vi.fn(),
  importServiceAccount: vi.fn(),
  installUpdate: vi.fn(),
  listPeriods: vi.fn(),
  onBusyChanged: vi.fn(),
  onMenu: vi.fn(),
  onSettingsChanged: vi.fn(),
  onUpdateCheckResult: vi.fn(),
  onUpdateProgress: vi.fn(),
  openReport: vi.fn(),
  openSettings: vi.fn(),
  pendingUpdate: vi.fn(),
  periodSummary: vi.fn(),
  pickReceiptsRoot: vi.fn(),
  pickStatements: vi.fn(),
  reopenPeriod: vi.fn(),
  revealPeriod: vi.fn(),
  requestAttention: vi.fn(),
  saveSettings: vi.fn(),
  showAlert: vi.fn(),
  setDockProgress: vi.fn(),
  setMenu: vi.fn(),
  setMenuItemText: vi.fn(),
  setMenuState: vi.fn(),
  setWindowTitle: vi.fn(),
  startReconcile: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn() }));

/** What the mocked review's `flush` returns. */
let reviewFlush: () => Promise<void> = () => Promise.resolve();

vi.mock("../review/Review", async () => {
  const { useImperativeHandle } = await import("react");
  const { ActionPopUpButton } = await import("../components/PopUpButton");
  const { ToolbarPortal } = await import("../components/Toolbar");
  return {
    Review: ({
      ref,
      period,
      toolbar,
      status,
      runSummary,
      moreActions,
      onChanged,
      onSaved,
      onError,
    }: {
      ref?: Ref<Partial<ReviewCommands>>;
      period: Period;
      toolbar: ToolbarSlots;
      status: string;
      runSummary?: string;
      moreActions: PopUpAction[];
      onChanged?: () => void;
      onSaved?: (period: Period) => void;
      onError: (e: unknown) => void;
    }) => {
      useImperativeHandle(ref, () => ({ flush: () => reviewFlush() }));
      return (
        <section aria-label="Review">
          <ToolbarPortal target={toolbar.subtitle}>{runSummary ?? status}</ToolbarPortal>
          <ToolbarPortal target={toolbar.trailing}>
            <ActionPopUpButton label="More Actions" actions={moreActions} />
          </ToolbarPortal>
          <p>{`Review ${period.year}-${period.month}`}</p>
          <button type="button" onClick={onChanged}>
            Change Review
          </button>
          <button type="button" onClick={() => onSaved?.(period)}>
            Save Review
          </button>
          <button type="button" onClick={() => onError({ kind: "io", message: "draft unreadable" })}>
            Fail Review
          </button>
        </section>
      );
    },
  };
});

let pushSettings: (view: AppStateView) => void;
let pushCheckResult: (result: UpdateCheckResult) => void;
let pushProgress: (progress: UpdateProgress) => void;
let pushMenu: (id: string) => void;

const UNCONFIGURED = makeView({
  settings: makeSettings({ receipts_root: null }),
  service_account: null,
  missing: ["receipts_root", "service_account"],
  configured: false,
});

const STATEMENT_PATH = "/Users/example/Downloads/extrato-2030-03.pdf";

const SUMMARY: Summary = {
  totalTransactions: 40,
  matched: 30,
  review: 6,
  unmatched: 4,
  bankFees: 0,
  totalReceipts: 36,
  matchedReceipts: 28,
  reviewReceipts: 6,
  unmatchedReceipts: 2,
  matchRate: 75,
};

function summary(year: string, month: string, patch: Partial<PeriodSummary> = {}): PeriodSummary {
  return { ...emptySummary({ year, month }), ...patch };
}

/** February in review, January finalized; March, the previous month, is missing from the listing. */
const LISTED: PeriodSummary[] = [
  summary("2030", "02", { status: "in_review", receipts: 30, transactions: 42, pending: 6 }),
  summary("2030", "01", { status: "finalized", receipts: 20, transactions: 25 }),
  summary("2029", "11", { status: "ready", receipts: 12 }),
];

/** The listing with March holding receipts, so a statement is all it needs to reconcile. */
const READY_LISTED: PeriodSummary[] = [summary("2030", "03", { status: "ready", receipts: 5 }), ...LISTED];

/** Paths dropped onto the window, delivered to the statements drop zone; null until the window listens for drops. */
let dropFiles: ((paths: string[]) => void) | null;
let uuid: number;

/** Sets the window width and tells the window it resized. */
function resizeWindow(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

beforeEach(() => {
  dropFiles = null;
  reviewFlush = () => Promise.resolve();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2030, 3, 15));
  localStorage.clear();
  resizeWindow(1200);
  uuid = 0;
  vi.mocked(showAlert).mockResolvedValue("cancel");
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    uuid += 1;
    return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
  });
  vi.mocked(getCurrentWebview).mockReturnValue({
    onDragDropEvent: (handler: (event: { payload: { type: "drop"; paths: string[] } }) => void) => {
      dropFiles = (paths) => handler({ payload: { type: "drop", paths } });
      return Promise.resolve(() => undefined);
    },
  } as unknown as ReturnType<typeof getCurrentWebview>);
  vi.mocked(listPeriods).mockResolvedValue(LISTED);
  vi.mocked(pickStatements).mockResolvedValue([]);
  vi.mocked(setWindowTitle).mockResolvedValue(undefined);
  vi.mocked(setMenu).mockResolvedValue(undefined);
  vi.mocked(setMenuState).mockResolvedValue(undefined);
  vi.mocked(setDockProgress).mockResolvedValue(undefined);
  vi.mocked(requestAttention).mockResolvedValue(undefined);
  vi.mocked(onMenu).mockImplementation((handler) => {
    pushMenu = handler;
    return Promise.resolve(() => undefined);
  });
  vi.mocked(onSettingsChanged).mockImplementation((handler) => {
    pushSettings = handler;
    return Promise.resolve(() => undefined);
  });
  vi.mocked(onBusyChanged).mockResolvedValue(() => undefined);
  vi.mocked(onUpdateCheckResult).mockImplementation((handler) => {
    pushCheckResult = handler;
    return Promise.resolve(() => undefined);
  });
  vi.mocked(onUpdateProgress).mockImplementation((handler) => {
    pushProgress = handler;
    return Promise.resolve(() => undefined);
  });
  vi.mocked(pendingUpdate).mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/**
 * Renders the main window and waits for its launch reads: the app state and, for a set-up app,
 * the months listing. With `listing: false` the test settles the listing itself.
 */
async function renderMain(view: AppStateView = makeView(), { listing = true }: { listing?: boolean } = {}) {
  vi.mocked(getAppState).mockResolvedValue(view);
  const before = vi.mocked(listPeriods).mock.results.length;
  const result = render(<Main />);
  await waitFor(() => expect(getAppState).toHaveBeenCalled());
  if (view.configured && listing) {
    await waitFor(() => expect(vi.mocked(listPeriods).mock.results.length).toBeGreaterThan(before));
    const started = vi.mocked(listPeriods).mock.results[before];
    await act(async () => {
      await Promise.resolve(started.value).catch(() => undefined);
    });
  }
  await act(async () => undefined);
  return result;
}

/** A run the test settles by hand, pushing events through the callback it was started with. */
function reconcileRun() {
  const result = deferred<Summary>();
  const cancel = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const handle: RunHandle<Summary> = { promise: result.promise, cancel };
  let onEvent: (event: RunEvent) => void = () => undefined;
  vi.mocked(startReconcile).mockImplementation((_year, _month, _statements, _clearCache, callback) => {
    onEvent = callback;
    return handle;
  });
  return { result, cancel, push: (event: RunEvent) =>
      act(async () => {
        onEvent(event);
        await nextFrame();
      }) };
}

function button(name: string, scope: HTMLElement = document.body): HTMLButtonElement {
  return within(scope).getByRole("button", { name }) as HTMLButtonElement;
}

function toolbar(): HTMLElement {
  return document.querySelector("header.titlebar") as HTMLElement;
}

function title(): string {
  return toolbar().querySelector(".titlebar__title")?.textContent ?? "";
}

function subtitle(): string {
  return toolbar().querySelector(".titlebar__subtitle")?.textContent ?? "";
}

function months(): string[] {
  const list = screen.queryByRole("listbox", { name: "Months" });
  if (!list) {
    return [];
  }
  return within(list)
    .queryAllByRole("option")
    .map((o) => `${o.getAttribute("aria-selected") === "true" ? "* " : ""}${o.textContent}`);
}

function selectMonth(name: RegExp) {
  fireEvent.mouseDown(within(screen.getByRole("listbox", { name: "Months" })).getByRole("option", { name }));
}

/** Picks an item from the toolbar's More Actions menu. */
function moreAction(label: string) {
  fireEvent.click(within(toolbar()).getByRole("button", { name: "More Actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
}

/** The items of the toolbar's More Actions menu, which it opens and closes again. */
function moreActions(): string[] {
  fireEvent.click(within(toolbar()).getByRole("button", { name: "More Actions" }));
  const items = within(screen.getByRole("menu"))
    .getAllByRole("menuitem")
    .map((o) => `${o.textContent}${(o as HTMLButtonElement).disabled ? " (disabled)" : ""}`);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  return items;
}

function steps(): string[] {
  return [...document.querySelectorAll(".step")].map((li) => `${li.className.replace("step step--", "")}: ${li.textContent}`);
}

/** Drops the statement once the statements screen listens for drops, and waits for its row. */
async function addStatement() {
  await waitFor(() => expect(dropFiles).not.toBeNull());
  await act(async () => dropFiles?.([STATEMENT_PATH]));
  expect(await screen.findByText("extrato-2030-03.pdf")).toBeTruthy();
}

/** Starts a reconcile of one statement for March and returns the run to drive. */
async function startReconciling() {
  const run = reconcileRun();
  vi.mocked(listPeriods).mockResolvedValue(READY_LISTED);
  await renderMain();
  await addStatement();
  fireEvent.click(button("Reconcile", toolbar()));
  return run;
}

describe("first run", () => {
  it("welcomes without the sidebar", async () => {
    await renderMain(UNCONFIGURED);
    expect(screen.getByRole("heading", { name: "Welcome to Concilia" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Months" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide Sidebar" })).toBeNull();
    expect(title()).toBe("");
    expect(toolbar().classList.contains("titlebar--plain")).toBe(true);
    expect(listPeriods).not.toHaveBeenCalled();
    expect(setWindowTitle).toHaveBeenLastCalledWith("Concilia");
    expect(document.title).toBe("Concilia");
  });

  it("opens from the setup read at launch without reading it again", async () => {
    render(<Main initialState={makeView()} />);
    await act(async () => undefined);
    expect(getAppState).not.toHaveBeenCalled();
    expect(listPeriods).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("navigation", { name: "Months" })).toBeTruthy();
  });

  it("shows the months once the settings are complete", async () => {
    await renderMain(UNCONFIGURED);
    await act(async () => pushSettings(makeView()));
    expect(screen.queryByRole("heading", { name: "Welcome to Concilia" })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Months" })).toBeTruthy();
    expect(listPeriods).toHaveBeenCalledTimes(1);
    expect(title()).toBe("March 2030");
    expect(setWindowTitle).toHaveBeenLastCalledWith("March 2030");
  });

  it("reports a Welcome error", async () => {
    const { pickReceiptsRoot } = await import("../lib/tauri");
    vi.mocked(pickReceiptsRoot).mockRejectedValue({ kind: "internal", message: "no dialog" });
    await renderMain(UNCONFIGURED);
    await act(async () => fireEvent.click(button("Choose…")));
    expect(screen.getByRole("alert").textContent).toContain("Details: no dialog");
  });
});

describe("load error", () => {
  it("shows the error and loads again on Try Again", async () => {
    vi.mocked(getAppState).mockRejectedValueOnce({ kind: "keychain", message: "denied" });
    render(<Main />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Details: denied");
    expect(within(alert).getByRole("heading", { name: "Couldn't Load Settings" })).toBeTruthy();
    vi.mocked(openSettings).mockResolvedValue(undefined);
    fireEvent.click(button("Open Settings…", alert));
    expect(openSettings).toHaveBeenCalledTimes(1);

    vi.mocked(getAppState).mockResolvedValueOnce(UNCONFIGURED);
    fireEvent.click(button("Try Again"));
    expect(await screen.findByRole("heading", { name: "Welcome to Concilia" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("finishing setup", () => {
  it("confirms it and selects the month to work on", async () => {
    localStorage.setItem("main.period", "2030-01");
    await renderMain(UNCONFIGURED);
    await act(async () => pushSettings(makeView()));
    expect(title()).toBe("March 2030");
    const banner = screen.getByText("You're set up.").closest<HTMLElement>(".banner")!;
    fireEvent.click(button("Dismiss", banner));
    expect(screen.queryByText("You're set up.")).toBeNull();
  });

  it("does not confirm a setup that was already done", async () => {
    await renderMain();
    expect(screen.queryByText("You're set up.")).toBeNull();
  });
});

describe("update banner", () => {
  it("announces a pending update", async () => {
    vi.mocked(pendingUpdate).mockResolvedValue({ version: "9.9.9", notes: null });
    await renderMain();
    const banner = await screen.findByRole("status");
    expect(banner.textContent).toContain("Concilia 9.9.9 is available.");
    expect(banner.className).toBe("update-card");
    expect(screen.getByRole("navigation", { name: "Months" }).contains(banner)).toBe(true);
    expect(within(banner).getAllByRole("button").map((b) => b.textContent)).toEqual(["Install and Relaunch", "Later"]);
  });

  it("announces it in the detail area while the sidebar is hidden or before setup", async () => {
    vi.mocked(pendingUpdate).mockResolvedValue({ version: "9.9.9", notes: null });
    localStorage.setItem("main.sidebar", "hidden");
    await renderMain();
    expect((await screen.findByRole("status")).closest("main.detail")).toBeTruthy();
    cleanup();
    await renderMain(UNCONFIGURED);
    expect((await screen.findByRole("status")).className).toContain("banner");
  });

  it("announces an update found by a background check", async () => {
    await renderMain();
    act(() => pushCheckResult({ update: null, error: "offline", manual: false }));
    expect(screen.queryByRole("status")).toBeNull();
    act(() => pushCheckResult({ update: { version: "9.9.10", notes: "Fixes." }, error: null, manual: false }));
    expect(screen.getByRole("status").textContent).toContain("Concilia 9.9.10 is available.");
  });

  it("says so when a check from the menu finds no update", async () => {
    await renderMain();
    act(() => pushCheckResult({ update: null, error: null, manual: true }));
    expect(showAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Concilia is up to date.", confirm: "OK" }),
    );
  });

  it("reports a failed check from the menu", async () => {
    await renderMain();
    act(() => pushCheckResult({ update: null, error: "offline", manual: true }));
    expect(showAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't check for updates.", message: expect.stringContaining("offline") }),
    );
  });

  it("stays quiet when a background check finds nothing", async () => {
    await renderMain();
    act(() => pushCheckResult({ update: null, error: null, manual: false }));
    expect(showAlert).not.toHaveBeenCalled();
  });

  it("shows the banner again for a check from the menu after Later", async () => {
    vi.mocked(pendingUpdate).mockResolvedValue({ version: "9.9.13", notes: null });
    await renderMain();
    fireEvent.click(await screen.findByRole("button", { name: "Later" }));
    expect(screen.queryByRole("status")).toBeNull();
    act(() => pushCheckResult({ update: { version: "9.9.13", notes: null }, error: null, manual: false }));
    expect(screen.queryByRole("status")).toBeNull();
    act(() => pushCheckResult({ update: { version: "9.9.13", notes: null }, error: null, manual: true }));
    expect(screen.getByRole("status").textContent).toContain("Concilia 9.9.13 is available.");
  });

  it("puts the update off with Later until the app runs again", async () => {
    vi.mocked(pendingUpdate).mockResolvedValue({ version: "9.9.11", notes: null });
    await renderMain();
    fireEvent.click(await screen.findByRole("button", { name: "Later" }));
    expect(screen.queryByRole("status")).toBeNull();
    cleanup();
    await renderMain();
    await act(async () => undefined);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => pushCheckResult({ update: { version: "9.9.12", notes: null }, error: null, manual: false }));
    expect(screen.getByRole("status").textContent).toContain("Concilia 9.9.12 is available.");
  });

  it("disables Install while a job runs", async () => {
    vi.mocked(pendingUpdate).mockResolvedValue({ version: "9.9.9", notes: null });
    await renderMain(makeView({ busy: true }));
    expect((await screen.findByRole("button", { name: "Install and Relaunch" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the install progress and reports a failed install", async () => {
    const install = deferred<void>();
    vi.mocked(installUpdate).mockReturnValue(install.promise);
    vi.mocked(pendingUpdate).mockResolvedValue({ version: "9.9.9", notes: null });
    await renderMain();
    fireEvent.click(await screen.findByRole("button", { name: "Install and Relaunch" }));
    act(() => pushProgress({ downloaded: 25, total: 100 }));
    expect(button("Downloading… 25%").disabled).toBe(true);
    await act(async () => install.reject({ kind: "network", message: "offline" }));
    expect(screen.getByRole("alert").textContent).toBe("Concilia can't reach Google. Check your internet connection and try again.Details: offline");
  });
});

describe("sidebar", () => {
  it("lists the months with the previous month added, and selects it", async () => {
    await renderMain();
    expect(months()).toEqual([
      "* MarchNo receipts",
      "FebruaryIn review · 6 to decide",
      "JanuaryFinalized",
      "NovemberNeeds statements · 12 receipts",
    ]);
    expect(screen.getByRole("group", { name: "2029" })).toBeTruthy();
    expect(title()).toBe("March 2030");
    expect(subtitle()).toBe("No receipts");
  });

  it("remembers the month selected", async () => {
    await renderMain();
    selectMonth(/January/);
    expect(localStorage.getItem("main.period")).toBe("2030-01");
    expect(title()).toBe("January 2030");
    expect(setWindowTitle).toHaveBeenLastCalledWith("January 2030");
    cleanup();

    await renderMain();
    expect(title()).toBe("January 2030");
    expect(months()[2]).toBe("* JanuaryFinalized");
  });

  it("keeps a remembered month the listing lacks", async () => {
    localStorage.setItem("main.period", "2025-06");
    await renderMain();
    expect(months()).toContain("* JuneNo receipts");
    expect(screen.getByRole("group", { name: "2025" })).toBeTruthy();
  });

  it("starts on the previous month when the remembered one is invalid", async () => {
    localStorage.setItem("main.period", "garbage");
    await renderMain();
    expect(title()).toBe("March 2030");
  });

  it("lists the months again when the window gets focus", async () => {
    await renderMain();
    vi.mocked(listPeriods).mockResolvedValue([summary("2030", "03", { status: "ready", receipts: 2 }), ...LISTED]);
    vi.setSystemTime(new Date(2030, 3, 15, 0, 0, 6));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(listPeriods).toHaveBeenCalledTimes(2);
    expect(months()[0]).toBe("* MarchNeeds statements · 2 receipts");
  });

  it("does not list the months again for a focus soon after a listing", async () => {
    await renderMain();
    vi.setSystemTime(new Date(2030, 3, 15, 0, 0, 3));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(listPeriods).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(2030, 3, 15, 0, 0, 6));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(listPeriods).toHaveBeenCalledTimes(2);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(listPeriods).toHaveBeenCalledTimes(2);
  });

  it("explains a listing that failed and lists again on Try Again", async () => {
    vi.mocked(listPeriods).mockRejectedValueOnce({ kind: "io", message: "unreadable" });
    await renderMain();
    const nav = screen.getByRole("navigation", { name: "Months" });
    expect(within(nav).getByRole("alert").textContent).toContain("Details: unreadable");
    await act(async () => fireEvent.click(button("Try Again", nav)));
    expect(within(nav).queryByRole("alert")).toBeNull();
    expect(months()).toHaveLength(4);
  });

  it("ignores a listing that arrives after a newer one", async () => {
    const slow = deferred<PeriodSummary[]>();
    vi.mocked(listPeriods).mockReturnValueOnce(slow.promise);
    await renderMain(makeView(), { listing: false });
    vi.setSystemTime(new Date(2030, 3, 15, 0, 0, 6));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(months()).toHaveLength(4);
    await act(async () => slow.resolve([]));
    expect(months()).toHaveLength(4);
  });

  it("shows no month statuses until the months have loaded", async () => {
    const listing = deferred<PeriodSummary[]>();
    vi.mocked(listPeriods).mockReturnValueOnce(listing.promise);
    await renderMain(makeView(), { listing: false });
    expect(months()).toEqual(["* March\u00a0"]);
    await act(async () => listing.resolve(LISTED));
    expect(months()[0]).toBe("* MarchNo receipts");
  });

  it("resizes from its divider within 180 to 280 pixels and remembers the width", async () => {
    await renderMain();
    const divider = screen.getByRole("separator", { name: "Resize Sidebar" });
    const width = () => (document.querySelector(".main") as HTMLElement).style.getPropertyValue("--sidebar-width");
    expect(width()).toBe("220px");
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(width()).toBe("230px");
    expect((toolbar().querySelector(".titlebar__leading") as HTMLElement).style.width).toBe("var(--sidebar-width)");
    fireEvent.keyDown(divider, { key: "Home" });
    expect(width()).toBe("180px");
    expect(localStorage.getItem("main.sidebarWidth")).toBe("180");
  });

  it("offers a month's commands on a right click", async () => {
    vi.mocked(revealPeriod).mockResolvedValue(undefined);
    await renderMain();
    const february = within(screen.getByRole("listbox", { name: "Months" })).getByRole("option", { name: /February/ });
    fireEvent.contextMenu(february);
    expect(title()).toBe("February 2030");
    fireEvent.click(screen.getByRole("menuitem", { name: "Show in Finder" }));
    expect(revealPeriod).toHaveBeenCalledWith("2030", "02");
    fireEvent.contextMenu(february);
    fireEvent.click(screen.getByRole("menuitem", { name: "Reconcile Again…" }));
    expect(showAlert).toHaveBeenCalledWith(expect.objectContaining({ title: "Reconcile February 2030 again?" }));
  });

  it("offers Open Report for a month with a report, and not for one without", async () => {
    vi.mocked(openReport).mockResolvedValue(undefined);
    await renderMain();
    const list = within(screen.getByRole("listbox", { name: "Months" }));
    fireEvent.contextMenu(list.getByRole("option", { name: /January/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open Report" }));
    expect(openReport).toHaveBeenCalledWith("2030", "01");
    fireEvent.contextMenu(list.getByRole("option", { name: /November/ }));
    expect(screen.queryByRole("menuitem", { name: "Open Report" })).toBeNull();
  });

  it("hides and shows the sidebar, and remembers it", async () => {
    await renderMain();
    expect(button("Hide Sidebar").getAttribute("aria-expanded")).toBeNull();
    fireEvent.click(button("Hide Sidebar"));
    expect(screen.queryByRole("navigation", { name: "Months" })).toBeNull();
    expect(localStorage.getItem("main.sidebar")).toBe("hidden");
    expect(toolbar().querySelector(".titlebar__leading--sidebar")).toBeNull();
    cleanup();

    await renderMain();
    expect(screen.queryByRole("navigation", { name: "Months" })).toBeNull();
    fireEvent.click(button("Show Sidebar"));
    expect(screen.getByRole("navigation", { name: "Months" })).toBeTruthy();
    expect(toolbar().querySelector(".titlebar__leading--sidebar")).toBeTruthy();
  });

  it("lays the sidebar over the content in a narrow window", async () => {
    resizeWindow(1000);
    await renderMain();
    expect(screen.queryByRole("navigation", { name: "Months" })).toBeNull();
    expect(toolbar().querySelector(".titlebar__leading--sidebar")).toBeNull();
    fireEvent.click(button("Show Sidebar"));
    const sidebar = screen.getByRole("navigation", { name: "Months" });
    expect(sidebar.classList.contains("sidebar--overlay")).toBe(true);
    expect(toolbar().querySelector(".titlebar__leading--sidebar")).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize Sidebar" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "Months" }));
    expect(localStorage.getItem("main.sidebar")).toBeNull();

    selectMonth(/January/);
    expect(title()).toBe("January 2030");
    expect(screen.queryByRole("navigation", { name: "Months" })).toBeNull();

    fireEvent.click(button("Show Sidebar"));
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Months" }), { key: "Escape" });
    expect(screen.queryByRole("navigation", { name: "Months" })).toBeNull();

    fireEvent.click(button("Show Sidebar"));
    fireEvent.pointerDown(document.querySelector(".detail")!);
    expect(screen.queryByRole("navigation", { name: "Months" })).toBeNull();
  });

  it("puts the sidebar back beside the content when the window widens", async () => {
    resizeWindow(1000);
    await renderMain();
    act(() => resizeWindow(1200));
    const sidebar = screen.getByRole("navigation", { name: "Months" });
    expect(sidebar.classList.contains("sidebar--overlay")).toBe(false);
    expect(toolbar().querySelector(".titlebar__leading--sidebar")).toBeTruthy();
  });

  it("adds and selects a new month", async () => {
    vi.mocked(createPeriod).mockImplementation((year, month) => {
      vi.mocked(listPeriods).mockResolvedValue([...LISTED, summary(year, month)]);
      return Promise.resolve(summary(year, month));
    });
    await renderMain();
    fireEvent.click(button("New Month…"));
    const sheet = screen.getByRole("dialog", { name: "New Month" });
    fireEvent.change(within(sheet).getByLabelText("Month"), { target: { value: "07" } });
    fireEvent.change(within(sheet).getByLabelText("Year"), { target: { value: "2028" } });
    await act(async () => fireEvent.click(button("Create", sheet)));
    expect(createPeriod).toHaveBeenCalledWith("2028", "07");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(title()).toBe("July 2028");
    expect(months()[months().length - 1]).toBe("* JulyNo receipts");

    selectMonth(/March/);
    expect(months()).toContain("JulyNo receipts");
  });

  it("keeps the New Month sheet open with the reason a month cannot be created", async () => {
    vi.mocked(createPeriod).mockRejectedValue({ kind: "io", message: "permission denied" });
    await renderMain();
    fireEvent.click(button("New Month…"));
    const sheet = screen.getByRole("dialog", { name: "New Month" });
    await act(async () => fireEvent.click(button("Create", sheet)));
    expect(within(sheet).getByRole("alert").textContent).toContain("Details: permission denied");
    expect(button("Create", sheet).disabled).toBe(false);
  });

  it("starts the New Month sheet on the month after the newest one", async () => {
    await renderMain();
    fireEvent.click(button("New Month…"));
    const sheet = screen.getByRole("dialog", { name: "New Month" });
    expect((within(sheet).getByLabelText("Month") as HTMLSelectElement).value).toBe("04");
    expect((within(sheet).getByLabelText("Year") as HTMLSelectElement).value).toBe("2030");
    fireEvent.change(within(sheet).getByLabelText("Month"), { target: { value: "01" } });
    expect(button("Create", sheet).disabled).toBe(true);
  });

  it("closes the New Month sheet on Cancel", async () => {
    await renderMain();
    fireEvent.click(button("New Month…"));
    fireEvent.click(button("Cancel", screen.getByRole("dialog")));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(title()).toBe("March 2030");
  });
});

describe("month without a match", () => {
  it("shows the drop zone, where receipts go and the actions", async () => {
    await renderMain();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Receipts", "Bank Statements"]);
    expect(screen.getByText("Drop March's bank statements here")).toBeTruthy();
    expect(screen.getByText("Put this month's receipts in /Users/example/Receipts/2030/03/receipts")).toBeTruthy();
    expect(button("Reconcile", toolbar()).disabled).toBe(true);
    expect(within(toolbar()).getByText("Add receipts and a statement first").id).toBe(button("Reconcile", toolbar()).getAttribute("aria-describedby"));
    expect(moreActions()).toEqual(["Open Report (disabled)", "Show in Finder"]);
  });

  it("shows the month in Finder from the hint and from More Actions", async () => {
    vi.mocked(revealPeriod).mockResolvedValue(undefined);
    await renderMain();
    await act(async () => fireEvent.click(button("Show in Finder")));
    await act(async () => moreAction("Show in Finder"));
    expect(revealPeriod).toHaveBeenCalledTimes(2);
    expect(revealPeriod).toHaveBeenCalledWith("2030", "03");
  });

  it("reports a folder that cannot be shown until dismissed or the month changes", async () => {
    vi.mocked(revealPeriod).mockRejectedValue({ kind: "not_found", message: "No folder for March 2030." });
    await renderMain();
    await act(async () => fireEvent.click(button("Show in Finder")));
    expect(screen.getByRole("alert").textContent).toContain("Details: No folder for March 2030.");
    fireEvent.click(button("Close"));
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => fireEvent.click(button("Show in Finder")));
    selectMonth(/November/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("counts the month's receipts and says what Reconcile still needs", async () => {
    vi.mocked(listPeriods).mockResolvedValue(READY_LISTED);
    await renderMain();
    expect(screen.getByText("5 receipts in this month's folder")).toBeTruthy();
    expect(within(toolbar()).getByText("Add a statement first")).toBeTruthy();
    await addStatement();
    expect(within(toolbar()).queryByText("Add a statement first")).toBeNull();
    expect(button("Reconcile", toolbar()).disabled).toBe(false);
    cleanup();

    await renderMain();
    selectMonth(/March/);
    vi.mocked(listPeriods).mockResolvedValue([summary("2030", "03", { status: "ready", transactions: 8 })]);
    vi.setSystemTime(new Date(2030, 3, 15, 0, 0, 6));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(subtitle()).toBe("Needs receipts");
    expect(within(toolbar()).getByText("Add receipts first")).toBeTruthy();
    expect(button("Reconcile", toolbar()).disabled).toBe(true);
  });

  it("keeps each month's statements when moving between months", async () => {
    vi.mocked(listPeriods).mockResolvedValue(READY_LISTED);
    await renderMain();
    await addStatement();
    expect(button("Reconcile", toolbar()).disabled).toBe(false);
    selectMonth(/November/);
    expect(screen.queryByText("extrato-2030-03.pdf")).toBeNull();
    expect(screen.queryByText(/Put this month's receipts/)).toBeNull();
    expect(button("Reconcile", toolbar()).disabled).toBe(true);
    selectMonth(/March/);
    expect(screen.getByText("extrato-2030-03.pdf")).toBeTruthy();
  });

  it("reconciles a month with saved transactions without statements", async () => {
    vi.mocked(listPeriods).mockResolvedValue([summary("2030", "03", { status: "ready", receipts: 3, transactions: 8 })]);
    reconcileRun();
    await renderMain();
    expect(subtitle()).toBe("Ready · 3 receipts");
    fireEvent.click(button("Reconcile", toolbar()));
    expect(startReconcile).toHaveBeenCalledWith("2030", "03", [], false, expect.any(Function));
  });
});

describe("month in review", () => {
  it("opens the review with the month's actions", async () => {
    await renderMain();
    selectMonth(/February/);
    expect(await screen.findByText("Review 2030-02")).toBeTruthy();
    expect(subtitle()).toBe("In review · 6 to decide");
    expect(within(toolbar()).queryByRole("button", { name: "Reconcile" })).toBeNull();
    expect(moreActions()).toEqual(["Open Report", "Show in Finder", "Reconcile Again…"]);
  });

  it("opens the report", async () => {
    vi.mocked(openReport).mockResolvedValue(undefined);
    await renderMain();
    selectMonth(/January/);
    await screen.findByText("Review 2030-01");
    expect(subtitle()).toBe("Finalized");
    await act(async () => moreAction("Open Report"));
    expect(openReport).toHaveBeenCalledWith("2030", "01");
  });

  it("reports a report that cannot be opened", async () => {
    vi.mocked(openReport).mockRejectedValue({ kind: "not_found", message: "No report yet." });
    await renderMain();
    selectMonth(/January/);
    await screen.findByText("Review 2030-01");
    await act(async () => moreAction("Open Report"));
    expect(screen.getByRole("alert").textContent).toContain("Details: No report yet.");
  });

  it("reports an error from the review", async () => {
    await renderMain();
    selectMonth(/February/);
    fireEvent.click(await screen.findByRole("button", { name: "Fail Review" }));
    expect(screen.getByRole("alert").textContent).toContain("Details: draft unreadable");
  });

  it("lists the months again when the review changes the month", async () => {
    await renderMain();
    selectMonth(/February/);
    vi.mocked(listPeriods).mockResolvedValue([summary("2030", "02", { status: "finalized" })]);
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Change Review" })));
    expect(listPeriods).toHaveBeenCalledTimes(2);
    expect(subtitle()).toBe("Finalized");
  });

  it("refreshes only the month's own entry after a draft save", async () => {
    await renderMain();
    selectMonth(/February/);
    vi.mocked(periodSummary).mockResolvedValue(summary("2030", "02", { status: "in_review", receipts: 30, transactions: 42, pending: 2 }));
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Save Review" })));
    expect(periodSummary).toHaveBeenCalledExactlyOnceWith("2030", "02");
    expect(listPeriods).toHaveBeenCalledTimes(1);
    expect(months().find((m) => m.includes("February"))).toContain("2 to decide");
    expect(months().find((m) => m.includes("January"))).toContain("Finalized");
  });

  it("lists every month when a single month cannot be read", async () => {
    await renderMain();
    selectMonth(/February/);
    vi.mocked(periodSummary).mockRejectedValue({ kind: "io", message: "unreadable" });
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Save Review" })));
    expect(listPeriods).toHaveBeenCalledTimes(2);
  });

  it("asks before re-running and re-runs from the saved transactions", async () => {
    const run = reconcileRun();
    await renderMain();
    selectMonth(/February/);
    await screen.findByText("Review 2030-02");
    vi.mocked(showAlert).mockResolvedValue("cancel");
    await act(async () => moreAction("Reconcile Again…"));
    expect(showAlert).toHaveBeenCalledWith({
      title: "Reconcile February 2030 again?",
      message: "Receipts that were sorted move back to the receipts folder, and Concilia reads every receipt again. This can take a while.",
      confirm: "Reconcile Again",
      cancel: "Cancel",
    });
    expect(startReconcile).not.toHaveBeenCalled();

    vi.mocked(showAlert).mockResolvedValue("confirm");
    await act(async () => moreAction("Reconcile Again…"));
    expect(startReconcile).toHaveBeenCalledWith("2030", "02", [], true, expect.any(Function));
    await run.push({ step: "parsing", count: 0 });
    expect(steps()[0]).toBe("running: Reading statements · using the saved transactions");
  });

  it("saves the review's pending decisions before re-running", async () => {
    reconcileRun();
    const saved = deferred<void>();
    reviewFlush = () => saved.promise;
    await renderMain();
    selectMonth(/February/);
    await screen.findByText("Review 2030-02");
    vi.mocked(showAlert).mockResolvedValue("confirm");
    await act(async () => moreAction("Reconcile Again…"));
    expect(startReconcile).not.toHaveBeenCalled();
    await act(async () => saved.resolve());
    expect(startReconcile).toHaveBeenCalledWith("2030", "02", [], true, expect.any(Function));
  });

  it("shows a failed save and does not re-run", async () => {
    reconcileRun();
    reviewFlush = () => Promise.reject({ kind: "io", message: "disk full" });
    await renderMain();
    selectMonth(/February/);
    await screen.findByText("Review 2030-02");
    vi.mocked(showAlert).mockResolvedValue("confirm");
    await act(async () => moreAction("Reconcile Again…"));
    expect(startReconcile).not.toHaveBeenCalled();
    expect(await screen.findByText(/disk full/)).toBeTruthy();
  });
});

describe("reconcile", () => {
  it("follows the run's progress inline, in the toolbar and in the sidebar", async () => {
    const run = await startReconciling();
    expect(startReconcile).toHaveBeenCalledWith("2030", "03", [{ path: STATEMENT_PATH, bank: "cgd" }], false, expect.any(Function));
    expect(screen.getByRole("heading", { name: "Reconciling March 2030" })).toBeTruthy();
    expect(subtitle()).toBe("Reconciling…");
    expect(months()[0]).toBe("* MarchReconciling…");
    expect(within(toolbar()).queryByRole("button", { name: "Reconcile" })).toBeNull();

    await run.push({ step: "parsing", count: 1 });
    await run.push({ step: "receipts_found", count: 40 });
    await run.push({ step: "extracting", current: 10, total: 40 });
    expect(steps().slice(0, 3)).toEqual([
      "done: Reading statements · 1 file",
      "done: Scanning receipts · 40 found",
      "running: Extracting receipt data · 10 of 40",
    ]);
    expect(subtitle()).toBe("Reading receipts: 10 of 40");
    expect(months()[0]).toBe("* MarchReading receipts: 10 of 40");
    expect(within(screen.getByRole("listbox", { name: "Months" })).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("10");
    expect(document.querySelectorAll(".run button")).toHaveLength(0);

    await run.push({ step: "matching" });
    expect(subtitle()).toBe("Reconciling…");
  });

  it("cancels from the toolbar", async () => {
    const run = await startReconciling();
    fireEvent.click(button("Cancel", toolbar()));
    expect(run.cancel).toHaveBeenCalledTimes(1);
    expect(button("Cancelling…", toolbar()).disabled).toBe(true);
  });

  it("goes straight to the review with the run's figures when it succeeds", async () => {
    const run = await startReconciling();
    vi.mocked(listPeriods).mockReturnValue(new Promise(() => undefined));
    await act(async () => run.result.resolve(SUMMARY));
    expect(screen.getByText("Review 2030-03")).toBeTruthy();
    expect(subtitle()).toBe("40 transactions · 36 receipts · 75% matched");
    expect(months()[0]).toBe("* MarchIn review · 10 to decide");
    expect(listPeriods).toHaveBeenCalledTimes(2);

    selectMonth(/February/);
    selectMonth(/March/);
    expect(subtitle()).toBe("In review · 10 to decide");
  });

  it("forgets the statements of a month that ran", async () => {
    const run = await startReconciling();
    vi.mocked(listPeriods).mockResolvedValue(LISTED);
    await act(async () => run.result.resolve(SUMMARY));
    expect(screen.queryByText("extrato-2030-03.pdf")).toBeNull();
    expect(button("Reconcile", toolbar()).disabled).toBe(true);
  });

  it("keeps running while another month is shown", async () => {
    const run = await startReconciling();
    selectMonth(/November/);
    expect(screen.queryByRole("heading", { name: "Reconciling March 2030" })).toBeNull();
    expect(subtitle()).toBe("Needs statements · 12 receipts");
    expect(button("Reconcile", toolbar()).disabled).toBe(true);
    expect(months()[0]).toBe("MarchReconciling…");

    vi.mocked(listPeriods).mockReturnValue(new Promise(() => undefined));
    await act(async () => run.result.resolve(SUMMARY));
    expect(title()).toBe("March 2030");
    expect(screen.getByText("Review 2030-03")).toBeTruthy();
  });

  it("explains a failed run and returns to the statements", async () => {
    const run = await startReconciling();
    await run.push({ step: "parsing", count: 1 });
    await act(async () => run.result.reject({ kind: "parse", message: "no transactions found" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Details: no transactions found");
    expect(alert.className).toContain("banner--error");
    expect(subtitle()).toBe("Failed");
    expect(steps()[0]).toBe("failed: Reading statements · 1 file");
    expect(within(toolbar()).queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Settings…" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Couldn't Reconcile March 2030" })).toBeTruthy();
    expect(months()[0]).toBe("* MarchFailed");

    fireEvent.click(button("Back to Statements"));
    expect(months()[0]).toBe("* MarchNeeds statements · 5 receipts");
    expect(screen.getByText("extrato-2030-03.pdf")).toBeTruthy();
    expect(button("Reconcile", toolbar()).disabled).toBe(false);
  });

  it("runs again the same way on Try Again", async () => {
    const run = await startReconciling();
    await act(async () => run.result.reject({ kind: "network", message: "offline" }));
    const again = reconcileRun();
    fireEvent.click(button("Try Again"));
    expect(startReconcile).toHaveBeenCalledTimes(2);
    expect(vi.mocked(startReconcile).mock.calls[1].slice(0, 4)).toEqual(["2030", "03", [{ path: STATEMENT_PATH, bank: "cgd" }], false]);
    expect(subtitle()).toBe("Reconciling…");
    await again.push({ step: "parsing", count: 1 });
  });

  it("offers Settings when the failure is fixed there", async () => {
    const run = await startReconciling();
    await act(async () => run.result.reject({ kind: "unauthorized", message: "token exchange failed" }));
    vi.mocked(openSettings).mockResolvedValue(undefined);
    fireEvent.click(button("Open Settings…"));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("says the run was stopped", async () => {
    const run = await startReconciling();
    fireEvent.click(button("Cancel", toolbar()));
    await act(async () => run.result.reject({ kind: "cancelled", message: "cancelled" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Reconciliation stopped.");
    expect(alert.className).toContain("banner--info");
    expect(subtitle()).toBe("Stopped");
    expect(screen.getByRole("heading", { name: "Stopped Reconciling March 2030" })).toBeTruthy();
    expect(months()[0]).toBe("* MarchStopped");
    expect(button("Try Again")).toBeTruthy();
  });

  it("keeps a failed month marked until the user leaves it", async () => {
    const run = await startReconciling();
    await act(async () => run.result.reject({ kind: "network", message: "offline" }));
    expect(months()[0]).toBe("* MarchFailed");
    selectMonth(/November/);
    expect(months()[0]).toBe("MarchNeeds statements · 5 receipts");
    selectMonth(/March/);
    expect(screen.queryByRole("heading", { name: "Couldn't Reconcile March 2030" })).toBeNull();
    expect(screen.getByText("extrato-2030-03.pdf")).toBeTruthy();
  });

  it("estimates the time left once three receipts are read", async () => {
    const run = await startReconciling();
    await run.push({ step: "receipts_found", count: 40 });
    for (const current of [0, 1, 2]) {
      vi.setSystemTime(new Date(2030, 3, 15, 0, 0, current * 10));
      await run.push({ step: "extracting", current, total: 40 });
    }
    expect(subtitle()).toBe("Reading receipts: 2 of 40");
    vi.setSystemTime(new Date(2030, 3, 15, 0, 0, 30));
    await run.push({ step: "extracting", current: 3, total: 40 });
    expect(steps()[2]).toBe("running: Extracting receipt data · 3 of 40 · About 6 min left");
    expect(subtitle()).toBe("Reading receipts: 3 of 40 · About 6 min left");
    vi.setSystemTime(new Date(2030, 3, 15, 0, 1, 0));
    await run.push({ step: "extracting", current: 39, total: 40 });
    expect(subtitle()).toBe("Reading receipts: 39 of 40 · Less than a minute left");
    await run.push({ step: "matching" });
    expect(subtitle()).toBe("Reconciling…");
  });

  it("cancels a running run when the window closes", async () => {
    const run = await startReconciling();
    cleanup();
    expect(run.cancel).toHaveBeenCalledTimes(1);
  });
});

describe("window title", () => {
  it("is not set in the browser preview", async () => {
    (window as unknown as Record<string, unknown>).__CONCILIA_PREVIEW__ = true;
    try {
      await renderMain();
      expect(document.title).toBe("March 2030");
      expect(setWindowTitle).not.toHaveBeenCalled();
    } finally {
      delete (window as unknown as Record<string, unknown>).__CONCILIA_PREVIEW__;
    }
  });

  it("logs a title that cannot be set", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(setWindowTitle).mockRejectedValue(new Error("denied"));
    await renderMain();
    expect(log).toHaveBeenCalledWith("could not set the window title", expect.any(Error));
  });
});

describe("app menu", () => {
  function lastMenuState(): Record<string, boolean> {
    const calls = vi.mocked(setMenuState).mock.calls;
    return calls[calls.length - 1][0];
  }

  it("sends only the always-on items before setup", async () => {
    await renderMain(UNCONFIGURED);
    expect(lastMenuState()).toMatchObject({ settings: true, help: true, new_month: false, toggle_sidebar: false });
  });

  it("enables the statements items on a month that accepts statements", async () => {
    vi.mocked(listPeriods).mockResolvedValue(READY_LISTED);
    await renderMain();
    expect(lastMenuState()).toMatchObject({ new_month: true, add_statements: true, reconcile: false, rerun: false, accept: false });
    await addStatement();
    expect(lastMenuState().reconcile).toBe(true);
  });

  it("enables the month items of a month in review", async () => {
    await renderMain();
    selectMonth(/February/);
    await screen.findByText("Review 2030-02");
    expect(lastMenuState()).toMatchObject({ add_statements: false, reconcile: false, rerun: true, open_report: true, reveal_period: true });
  });

  it("opens the New Month sheet from the menu", async () => {
    await renderMain();
    act(() => pushMenu("new_month"));
    expect(screen.getByRole("dialog", { name: "New Month" })).toBeTruthy();
  });

  it("reconciles from the menu", async () => {
    reconcileRun();
    vi.mocked(listPeriods).mockResolvedValue(READY_LISTED);
    await renderMain();
    await addStatement();
    act(() => pushMenu("reconcile"));
    expect(startReconcile).toHaveBeenCalledWith("2030", "03", [{ path: STATEMENT_PATH, bank: "cgd" }], false, expect.any(Function));
  });

  it("opens the file picker from the menu", async () => {
    await renderMain();
    await act(async () => pushMenu("add_statements"));
    expect(pickStatements).toHaveBeenCalledTimes(1);
  });

  it("reveals the month and toggles the sidebar from the menu", async () => {
    vi.mocked(revealPeriod).mockResolvedValue(undefined);
    await renderMain();
    act(() => pushMenu("reveal_period"));
    expect(revealPeriod).toHaveBeenCalledWith("2030", "03");
    expect(screen.getByRole("navigation", { name: "Months" })).toBeTruthy();
    await act(async () => pushMenu("toggle_sidebar"));
    expect(screen.queryByRole("navigation", { name: "Months" })).toBeNull();
    expect(vi.mocked(setMenu).mock.calls[vi.mocked(setMenu).mock.calls.length - 1][0].toggle_sidebar).toBe("Show Sidebar");
  });

  it("re-runs and opens the report of a month in review from the menu", async () => {
    vi.mocked(openReport).mockResolvedValue(undefined);
    await renderMain();
    selectMonth(/February/);
    await screen.findByText("Review 2030-02");
    act(() => pushMenu("open_report"));
    expect(openReport).toHaveBeenCalledWith("2030", "02");
    act(() => pushMenu("rerun"));
    expect(showAlert).toHaveBeenCalledWith(expect.objectContaining({ title: "Reconcile February 2030 again?" }));
  });
});

describe("reopen", () => {
  it("reopens a finalized month after the alert and lists the months again", async () => {
    vi.mocked(showAlert).mockResolvedValue("confirm");
    vi.mocked(reopenPeriod).mockResolvedValue({ restored: 3, keptDecisions: 1 });
    await renderMain();
    selectMonth(/January/);
    await screen.findByText("Review 2030-01");
    await act(async () => pushMenu("reopen"));
    expect(showAlert).toHaveBeenCalledWith(expect.objectContaining({ title: "Reopen January 2030?", confirm: "Reopen" }));
    expect(reopenPeriod).toHaveBeenCalledWith("2030", "01");
    expect(listPeriods).toHaveBeenCalledTimes(2);
  });

  it("keeps Reopen Month off for a month in review", async () => {
    await renderMain();
    selectMonth(/February/);
    await screen.findByText("Review 2030-02");
    await act(async () => pushMenu("reopen"));
    expect(showAlert).not.toHaveBeenCalled();
  });
});

describe("dock progress", () => {
  it("follows the receipts being read and clears when the run ends", async () => {
    const run = await startReconciling();
    expect(setDockProgress).toHaveBeenLastCalledWith("indeterminate");
    await run.push({ step: "extracting", current: 10, total: 40 });
    expect(setDockProgress).toHaveBeenLastCalledWith(25);
    await act(async () => run.result.reject(new Error("failed")));
    expect(setDockProgress).toHaveBeenLastCalledWith(null);
  });

  it("requests attention when the run ends in the background", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const run = await startReconciling();
    await act(async () => run.result.reject(new Error("failed")));
    expect(requestAttention).toHaveBeenCalledTimes(1);
  });
});
