// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PopUpAction } from "../components/PopUpButton";
import type { ToolbarSlots } from "../components/Toolbar";
import { emptySummary, type Period } from "../lib/period";
import {
  getAppState,
  installUpdate,
  listPeriods,
  onBusyChanged,
  onMenu,
  onSettingsChanged,
  onUpdateCheckResult,
  onUpdateProgress,
  openReport,
  pendingUpdate,
  pickStatements,
  requestAttention,
  revealPeriod,
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
import { deferred, makeSettings, makeView } from "../test/fixtures";
import { Main } from "./Main";

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  cancelRun: vi.fn(),
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
  pickReceiptsRoot: vi.fn(),
  pickStatements: vi.fn(),
  revealPeriod: vi.fn(),
  requestAttention: vi.fn(),
  saveSettings: vi.fn(),
  setDockProgress: vi.fn(),
  setMenu: vi.fn(),
  setMenuState: vi.fn(),
  setWindowTitle: vi.fn(),
  startReconcile: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn() }));

vi.mock("../review/Review", async () => {
  const { ActionPopUpButton } = await import("../components/PopUpButton");
  const { ToolbarPortal } = await import("../components/Toolbar");
  return {
    Review: ({
      period,
      toolbar,
      status,
      runSummary,
      moreActions,
      onChanged,
      onError,
    }: {
      period: Period;
      toolbar: ToolbarSlots;
      status: string;
      runSummary?: string;
      moreActions: PopUpAction[];
      onChanged?: () => void;
      onError: (e: unknown) => void;
    }) => (
      <section aria-label="Review">
        <ToolbarPortal target={toolbar.subtitle}>{runSummary ?? status}</ToolbarPortal>
        <ToolbarPortal target={toolbar.trailing}>
          <ActionPopUpButton label="More Actions" actions={moreActions} />
        </ToolbarPortal>
        <p>{`Review ${period.year}-${period.month}`}</p>
        <button type="button" onClick={onChanged}>
          Change Review
        </button>
        <button type="button" onClick={() => onError({ kind: "io", message: "draft unreadable" })}>
          Fail Review
        </button>
      </section>
    ),
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

/** Paths dropped onto the window, delivered to the statements drop zone. */
let dropFiles: (paths: string[]) => void;
let uuid: number;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2030, 3, 15));
  localStorage.clear();
  uuid = 0;
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

async function renderMain(view: AppStateView = makeView()) {
  vi.mocked(getAppState).mockResolvedValue(view);
  const result = render(<Main />);
  await waitFor(() => expect(getAppState).toHaveBeenCalled());
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
  return { result, cancel, push: (event: RunEvent) => act(() => onEvent(event)) };
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
  fireEvent.click(within(screen.getByRole("listbox", { name: "Months" })).getByRole("option", { name }));
}

/** Picks an item from the toolbar's More Actions menu. */
function moreAction(label: string) {
  const select = within(toolbar()).getByLabelText("More Actions") as HTMLSelectElement;
  const option = within(select)
    .getAllByRole("option")
    .find((o) => o.textContent === label) as HTMLOptionElement;
  fireEvent.change(select, { target: { value: option.value } });
}

function moreActions(): string[] {
  const select = within(toolbar()).getByLabelText("More Actions");
  return within(select)
    .getAllByRole("option")
    .filter((o) => !(o as HTMLOptionElement).hidden)
    .map((o) => `${o.textContent}${(o as HTMLOptionElement).disabled ? " (disabled)" : ""}`);
}

function steps(): string[] {
  return [...document.querySelectorAll(".step")].map((li) => `${li.className.replace("step step--", "")}: ${li.textContent}`);
}

async function addStatement() {
  await act(async () => dropFiles([STATEMENT_PATH]));
  expect(screen.getByText("extrato-2030-03.pdf")).toBeTruthy();
}

/** Starts a reconcile of one statement for March and returns the run to drive. */
async function startReconciling() {
  const run = reconcileRun();
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

    vi.mocked(getAppState).mockResolvedValueOnce(UNCONFIGURED);
    fireEvent.click(button("Try Again"));
    expect(await screen.findByRole("heading", { name: "Welcome to Concilia" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("update banner", () => {
  it("announces a pending update", async () => {
    vi.mocked(pendingUpdate).mockResolvedValue({ version: "9.9.9", notes: null });
    await renderMain();
    const banner = await screen.findByRole("status");
    expect(banner.textContent).toContain("Concilia 9.9.9 is available.");
  });

  it("announces an update found by a background check", async () => {
    await renderMain();
    act(() => pushCheckResult({ update: null, error: "offline" }));
    expect(screen.queryByRole("status")).toBeNull();
    act(() => pushCheckResult({ update: { version: "9.9.10", notes: "Fixes." }, error: null }));
    expect(screen.getByRole("status").textContent).toContain("Concilia 9.9.10 is available.");
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
      "NovemberReady · 12 receipts",
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
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(listPeriods).toHaveBeenCalledTimes(2);
    expect(months()[0]).toBe("* MarchReady · 2 receipts");
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
    await renderMain();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(months()).toHaveLength(4);
    await act(async () => slow.resolve([]));
    expect(months()).toHaveLength(4);
  });

  it("hides and shows the sidebar, and remembers it", async () => {
    await renderMain();
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

  it("adds and selects a new month", async () => {
    await renderMain();
    fireEvent.click(button("New Month…"));
    const sheet = screen.getByRole("dialog", { name: "New Month" });
    fireEvent.change(within(sheet).getByLabelText("Month"), { target: { value: "07" } });
    fireEvent.change(within(sheet).getByLabelText("Year"), { target: { value: "2028" } });
    fireEvent.click(button("Create", sheet));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(title()).toBe("July 2028");
    expect(months()[months().length - 1]).toBe("* JulyNo receipts");

    selectMonth(/March/);
    expect(months()).toContain("JulyNo receipts");
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
    expect(screen.getByText("Drop March's bank statements here")).toBeTruthy();
    expect(screen.getByText("Put this month's receipts in /Users/example/Receipts/2030/03/receipts")).toBeTruthy();
    expect(button("Reconcile", toolbar()).disabled).toBe(true);
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

  it("keeps each month's statements when moving between months", async () => {
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

  it("asks before re-running and re-runs from the saved transactions", async () => {
    const run = reconcileRun();
    await renderMain();
    selectMonth(/February/);
    await screen.findByText("Review 2030-02");
    moreAction("Reconcile Again…");
    const sheet = screen.getByRole("alertdialog", { name: "Reconcile February 2030 again?" });
    fireEvent.click(button("Cancel", sheet));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(startReconcile).not.toHaveBeenCalled();

    moreAction("Reconcile Again…");
    fireEvent.click(button("Reconcile Again", screen.getByRole("alertdialog")));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(startReconcile).toHaveBeenCalledWith("2030", "02", [], true, expect.any(Function));
    run.push({ step: "parsing", count: 0 });
    expect(steps()[0]).toBe("running: Reading statements · using the saved transactions");
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

    run.push({ step: "parsing", count: 1 });
    run.push({ step: "receipts_found", count: 40 });
    run.push({ step: "extracting", current: 10, total: 40 });
    expect(steps().slice(0, 3)).toEqual([
      "done: Reading statements · 1 file",
      "done: Scanning receipts · 40 found",
      "running: Extracting receipt data · 10 / 40",
    ]);
    expect(subtitle()).toBe("10 / 40");
    expect(months()[0]).toBe("* March10 / 40");

    run.push({ step: "matching" });
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
    expect(subtitle()).toBe("Ready · 12 receipts");
    expect(button("Reconcile", toolbar()).disabled).toBe(true);
    expect(months()[0]).toBe("MarchReconciling…");

    vi.mocked(listPeriods).mockReturnValue(new Promise(() => undefined));
    await act(async () => run.result.resolve(SUMMARY));
    expect(title()).toBe("March 2030");
    expect(screen.getByText("Review 2030-03")).toBeTruthy();
  });

  it("explains a failed run and returns to the statements on Try Again", async () => {
    const run = await startReconciling();
    run.push({ step: "parsing", count: 1 });
    await act(async () => run.result.reject({ kind: "parse", message: "no transactions found" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Details: no transactions found");
    expect(alert.className).toContain("banner--error");
    expect(steps()[0]).toBe("failed: Reading statements · 1 file");
    expect(within(toolbar()).queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(months()[0]).toBe("* MarchNo receipts");

    fireEvent.click(button("Try Again", alert));
    expect(screen.getByText("extrato-2030-03.pdf")).toBeTruthy();
    expect(button("Reconcile", toolbar()).disabled).toBe(false);
  });

  it("says the run was stopped", async () => {
    const run = await startReconciling();
    fireEvent.click(button("Cancel", toolbar()));
    await act(async () => run.result.reject({ kind: "cancelled", message: "cancelled" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Reconciliation stopped.Try Again");
    expect(alert.className).toContain("banner--info");
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
    expect(screen.getByRole("alertdialog", { name: "Reconcile February 2030 again?" })).toBeTruthy();
  });
});

describe("dock progress", () => {
  it("follows the receipts being read and clears when the run ends", async () => {
    const run = await startReconciling();
    expect(setDockProgress).toHaveBeenLastCalledWith("indeterminate");
    run.push({ step: "extracting", current: 10, total: 40 });
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
