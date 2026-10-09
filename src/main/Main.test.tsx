// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Period } from "../lib/period";
import {
  exportReport,
  getAppState,
  installUpdate,
  onBusyChanged,
  onSettingsChanged,
  onUpdateCheckResult,
  onUpdateProgress,
  openReport,
  openSettings,
  pendingUpdate,
  periodStatus,
  pickStatements,
  revealPeriod,
  startReconcile,
  startScan,
  type AppStateView,
  type PeriodStatus,
  type RunEvent,
  type RunHandle,
  type ScanResult,
  type Summary,
  type UpdateCheckResult,
  type UpdateProgress,
} from "../lib/tauri";
import { deferred, makeSettings, makeView } from "../test/fixtures";
import { Main } from "./Main";

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  cancelRun: vi.fn(),
  exportReport: vi.fn(),
  getAppState: vi.fn(),
  installUpdate: vi.fn(),
  onBusyChanged: vi.fn(),
  onSettingsChanged: vi.fn(),
  onUpdateCheckResult: vi.fn(),
  onUpdateProgress: vi.fn(),
  openReport: vi.fn(),
  openSettings: vi.fn(),
  pendingUpdate: vi.fn(),
  periodStatus: vi.fn(),
  pickStatements: vi.fn(),
  revealPeriod: vi.fn(),
  startReconcile: vi.fn(),
  startScan: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn() }));

vi.mock("../review/Review", () => ({
  Review: ({ period, onBack, onError }: { period: Period; onBack: () => void; onError: (e: unknown) => void }) => (
    <section>
      <h1>{`Review ${period.year}-${period.month}`}</h1>
      <button type="button" onClick={onBack}>
        Back to Start
      </button>
      <button type="button" onClick={() => onError({ kind: "io", message: "draft unreadable" })}>
        Fail Review
      </button>
    </section>
  ),
}));

let pushSettings: (view: AppStateView) => void;
let pushCheckResult: (result: UpdateCheckResult) => void;
let pushProgress: (progress: UpdateProgress) => void;

const UNCONFIGURED = makeView({
  settings: makeSettings({ receipts_root: null }),
  service_account: null,
  missing: ["receipts_root", "service_account", "project"],
  configured: false,
});

const NO_PERIOD: PeriodStatus = { exists: false, applied: false, has_transactions: false, has_draft: false };

/** Paths dropped onto the window, delivered to the start screen. */
let dropFiles: (paths: string[]) => void;
let uuid: number;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2030, 3, 15));
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
  vi.mocked(periodStatus).mockResolvedValue(NO_PERIOD);
  vi.mocked(pickStatements).mockResolvedValue([]);
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
  vi.mocked(openSettings).mockResolvedValue(undefined);
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

describe("setup", () => {
  it("lists each missing step", async () => {
    await renderMain(UNCONFIGURED);
    expect(screen.getByRole("heading", { name: "Set up Concilia" })).toBeTruthy();
    expect(screen.getByText("Finish these steps in Settings before reconciling a month:")).toBeTruthy();
    const steps = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(steps).toEqual([
      "Choose the folder that holds your receipts.",
      "Import a Google Cloud service account key for Gemini.",
      "Enter the Google Cloud project to bill.",
    ]);
  });

  it("lists only what is missing", async () => {
    await renderMain(makeView({ missing: ["project"], configured: false }));
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Enter the Google Cloud project to bill."]);
  });

  it("opens Settings", async () => {
    await renderMain(UNCONFIGURED);
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("reports a failure to open Settings", async () => {
    vi.mocked(openSettings).mockRejectedValue({ kind: "internal", message: "no window" });
    await renderMain(UNCONFIGURED);
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Something went wrong: no window");
    expect(screen.queryByRole("button", { name: "Try Again" })).toBeNull();
  });

  it("shows nothing once configured", async () => {
    await renderMain();
    expect(screen.queryByRole("heading", { name: "Set up Concilia" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("hides the steps when settings change to configured", async () => {
    await renderMain(UNCONFIGURED);
    act(() => pushSettings(makeView()));
    expect(screen.queryByRole("heading", { name: "Set up Concilia" })).toBeNull();
  });
});

describe("load error", () => {
  it("shows the error and loads again on Try Again", async () => {
    vi.mocked(getAppState).mockRejectedValueOnce({ kind: "keychain", message: "denied" });
    render(<Main />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Concilia can't use the Keychain: denied");

    vi.mocked(getAppState).mockResolvedValueOnce(UNCONFIGURED);
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(await screen.findByRole("heading", { name: "Set up Concilia" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("update banner", () => {
  it("announces a pending update", async () => {
    vi.mocked(pendingUpdate).mockResolvedValue({ version: "9.9.9", notes: null });
    await renderMain();
    const banner = await screen.findByRole("status");
    expect(banner.textContent).toContain("Concilia 9.9.9 is available.");
    expect(screen.getByRole("button", { name: "Install and Relaunch" })).toBeTruthy();
  });

  it("stays hidden when the pending update check fails", async () => {
    vi.mocked(pendingUpdate).mockRejectedValue(new Error("offline"));
    await renderMain();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("announces an update found by a background check", async () => {
    await renderMain();
    act(() => pushCheckResult({ update: null, error: "offline" }));
    expect(screen.queryByRole("status")).toBeNull();
    act(() => pushCheckResult({ update: { version: "9.9.10", notes: "Fixes." }, error: null }));
    expect(screen.getByRole("status").textContent).toContain("Concilia 9.9.10 is available.");
  });

  it("keeps an announced update when a later check finds none", async () => {
    vi.mocked(pendingUpdate).mockResolvedValue({ version: "9.9.9", notes: null });
    await renderMain();
    await screen.findByRole("status");
    act(() => pushCheckResult({ update: null, error: null }));
    expect(screen.getByRole("status").textContent).toContain("Concilia 9.9.9 is available.");
  });

  it("shows the install progress", async () => {
    const install = deferred<void>();
    vi.mocked(installUpdate).mockReturnValue(install.promise);
    vi.mocked(pendingUpdate).mockResolvedValue({ version: "9.9.9", notes: null });
    await renderMain();
    fireEvent.click(await screen.findByRole("button", { name: "Install and Relaunch" }));
    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Downloading…" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => pushProgress({ downloaded: 25, total: 100 }));
    expect(screen.getByRole("button", { name: "Downloading… 25%" })).toBeTruthy();
    act(() => pushProgress({ downloaded: 100, total: 100 }));
    expect(screen.getByRole("button", { name: "Installing…" })).toBeTruthy();
  });

  it("reports a failed install", async () => {
    vi.mocked(installUpdate).mockRejectedValue({ kind: "network", message: "offline" });
    vi.mocked(pendingUpdate).mockResolvedValue({ version: "9.9.9", notes: null });
    await renderMain();
    fireEvent.click(await screen.findByRole("button", { name: "Install and Relaunch" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Concilia can't reach the server. Check your internet connection.");
    expect((screen.getByRole("button", { name: "Install and Relaunch" }) as HTMLButtonElement).disabled).toBe(false);
  });
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

/** A run the test settles by hand, pushing events through the callback it was started with. */
function fakeRun<T>() {
  const result = deferred<T>();
  const cancel = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const handle: RunHandle<T> = { promise: result.promise, cancel };
  let onEvent: (event: RunEvent) => void = () => undefined;
  return {
    result,
    cancel,
    start: (callback: (event: RunEvent) => void) => {
      onEvent = callback;
      return handle;
    },
    push: (event: RunEvent) => act(() => onEvent(event)),
  };
}

function reconcileRun() {
  const run = fakeRun<Summary>();
  vi.mocked(startReconcile).mockImplementation((_year, _month, _statements, _clearCache, onEvent) => run.start(onEvent));
  return run;
}

function scanRun() {
  const run = fakeRun<ScanResult>();
  vi.mocked(startScan).mockImplementation((_year, _month, onEvent) => run.start(onEvent));
  return run;
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function steps(): string[] {
  return [...document.querySelectorAll(".step")].map((li) => `${li.className.replace("step step--", "")}: ${li.textContent}`);
}

async function addStatement() {
  await act(async () => dropFiles([STATEMENT_PATH]));
  expect(screen.getByText("extrato-2030-03.pdf")).toBeTruthy();
}

/** Starts a reconcile of one statement and returns the run to drive. */
async function startReconciling() {
  const run = reconcileRun();
  await renderMain();
  await addStatement();
  fireEvent.click(button("Reconcile"));
  return run;
}

/** Reconciles one statement through to the summary. */
async function reconciled() {
  const run = await startReconciling();
  await act(async () => run.result.resolve(SUMMARY));
  expect(screen.getByRole("heading", { name: "March 2030 reconciled" })).toBeTruthy();
  return run;
}

describe("start", () => {
  it("shows the start screen on the previous month once configured", async () => {
    await renderMain();
    expect(screen.getByRole("heading", { name: "Reconcile a month" })).toBeTruthy();
    expect((screen.getByLabelText("Month") as HTMLSelectElement).value).toBe("03");
    expect((screen.getByLabelText("Year") as HTMLSelectElement).value).toBe("2030");
    expect(periodStatus).toHaveBeenCalledWith("2030", "03");
  });

  it("starts on December of the previous year in January", async () => {
    vi.setSystemTime(new Date(2030, 0, 10));
    await renderMain();
    expect((screen.getByLabelText("Month") as HTMLSelectElement).value).toBe("12");
    expect((screen.getByLabelText("Year") as HTMLSelectElement).value).toBe("2029");
    expect(periodStatus).toHaveBeenCalledWith("2029", "12");
  });

  it("reports a period status that cannot be loaded", async () => {
    vi.mocked(periodStatus).mockRejectedValue({ kind: "io", message: "unreadable" });
    await renderMain();
    expect((await screen.findByRole("alert")).textContent).toBe("Concilia couldn't read or write a file: unreadable");
  });

  it("dismisses a message", async () => {
    vi.mocked(periodStatus).mockRejectedValue({ kind: "io", message: "unreadable" });
    await renderMain();
    await screen.findByRole("alert");
    fireEvent.click(button("Close"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears a message when the period changes", async () => {
    vi.mocked(periodStatus).mockRejectedValueOnce({ kind: "io", message: "unreadable" });
    await renderMain();
    await screen.findByRole("alert");
    await act(async () => fireEvent.change(screen.getByLabelText("Month"), { target: { value: "02" } }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(periodStatus).toHaveBeenLastCalledWith("2030", "02");
  });

  it("opens the review on Resume Review and returns to the start", async () => {
    vi.mocked(periodStatus).mockResolvedValue({ exists: true, applied: false, has_transactions: true, has_draft: true });
    await renderMain();
    fireEvent.click(button("Resume Review"));
    expect(await screen.findByRole("heading", { name: "Review 2030-03" })).toBeTruthy();
    fireEvent.click(button("Back to Start"));
    expect(screen.getByRole("heading", { name: "Reconcile a month" })).toBeTruthy();
  });

  it("reports an error from the review", async () => {
    vi.mocked(periodStatus).mockResolvedValue({ exists: true, applied: true, has_transactions: true, has_draft: false });
    await renderMain();
    fireEvent.click(button("Resume Review"));
    fireEvent.click(await screen.findByRole("button", { name: "Fail Review" }));
    expect(screen.getByRole("alert").textContent).toBe("Concilia couldn't read or write a file: draft unreadable");
  });
});

describe("reconcile", () => {
  it("runs the statements for the period and follows its progress", async () => {
    const run = await startReconciling();
    expect(startReconcile).toHaveBeenCalledWith("2030", "03", [{ path: STATEMENT_PATH, bank: "cgd" }], false, expect.any(Function));
    expect(screen.getByRole("heading", { name: "Reconciling March 2030" })).toBeTruthy();
    expect(steps()).toEqual([
      "pending: Parsing statements",
      "pending: Scanning receipts",
      "pending: Extracting receipt data",
      "pending: Matching",
      "pending: Reading reimbursements",
      "pending: Generating report",
    ]);

    run.push({ step: "parsing", count: 1 });
    run.push({ step: "receipts_found", count: 40 });
    run.push({ step: "extracting", current: 10, total: 40 });
    expect(steps()).toEqual([
      "done: Parsing statements · 1 file",
      "done: Scanning receipts · 40 found",
      "running: Extracting receipt data · 10 / 40",
      "pending: Matching",
      "pending: Reading reimbursements",
      "pending: Generating report",
    ]);
    expect((screen.getByRole("progressbar", { name: "Extracting receipt data" }) as HTMLProgressElement).value).toBe(10);

    run.push({ step: "matching" });
    run.push({ step: "exporting" });
    expect(steps().slice(3)).toEqual(["done: Matching", "done: Reading reimbursements", "running: Generating report"]);
  });

  it("shows the summary when the run succeeds", async () => {
    await reconciled();
    expect(screen.getByText("40 transactions · 36 receipts")).toBeTruthy();
    expect(screen.queryByText("Bank fees")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(button("Review & Validate"));
    expect(await screen.findByRole("heading", { name: "Review 2030-03" })).toBeTruthy();
  });

  it("re-runs from scratch with the saved transactions", async () => {
    vi.mocked(periodStatus).mockResolvedValue({ exists: true, applied: true, has_transactions: true, has_draft: false });
    const run = reconcileRun();
    await renderMain();
    fireEvent.click(button("Re-run"));
    expect(startReconcile).toHaveBeenCalledWith("2030", "03", [], true, expect.any(Function));
    run.push({ step: "parsing", count: 0 });
    expect(steps()[0]).toBe("running: Parsing statements · using the saved transactions");
  });

  it("reconciles the period picked", async () => {
    reconcileRun();
    await renderMain();
    await act(async () => fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2029" } }));
    await addStatement();
    fireEvent.click(button("Reconcile"));
    expect(startReconcile).toHaveBeenCalledWith("2029", "03", [{ path: STATEMENT_PATH, bank: "cgd" }], false, expect.any(Function));
    expect(screen.getByRole("heading", { name: "Reconciling March 2029" })).toBeTruthy();
  });

  it("cancels the run", async () => {
    const run = await startReconciling();
    fireEvent.click(button("Cancel"));
    expect(run.cancel).toHaveBeenCalledTimes(1);
    expect(button("Stopping…").disabled).toBe(true);
  });

  it("says the run was stopped and returns to the start on Try Again", async () => {
    const run = await startReconciling();
    run.push({ step: "parsing", count: 1 });
    fireEvent.click(button("Cancel"));
    await act(async () => run.result.reject({ kind: "cancelled", message: "cancelled" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("The reconciliation was stopped.Try Again");
    expect(alert.className).toContain("banner--info");
    expect(steps()[0]).toBe("failed: Parsing statements · 1 file");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    fireEvent.click(within(alert).getByRole("button", { name: "Try Again" }));
    expect(screen.getByRole("heading", { name: "Reconcile a month" })).toBeTruthy();
    expect(screen.getByText("extrato-2030-03.pdf")).toBeTruthy();
  });

  it("explains a failed run", async () => {
    const run = await startReconciling();
    run.push({ step: "parsing", count: 1 });
    await act(async () => run.result.reject({ kind: "parse", message: "no transactions found" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Concilia couldn't read the statement: no transactions foundTry Again");
    expect(alert.className).toContain("banner--error");
    expect(steps()[0]).toBe("failed: Parsing statements · 1 file");

    const next = reconcileRun();
    fireEvent.click(button("Try Again"));
    fireEvent.click(button("Reconcile"));
    expect(startReconcile).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => next.result.resolve(SUMMARY));
    expect(screen.getByRole("heading", { name: "March 2030 reconciled" })).toBeTruthy();
  });

  it("cancels a running run when the window closes", async () => {
    const run = await startReconciling();
    cleanup();
    expect(run.cancel).toHaveBeenCalledTimes(1);
  });
});

describe("scan", () => {
  const UNFINISHED: PeriodStatus = { exists: true, applied: false, has_transactions: true, has_draft: true };

  it("scans the period and lists the decisions it dropped", async () => {
    vi.mocked(periodStatus).mockResolvedValue(UNFINISHED);
    const run = scanRun();
    await renderMain();
    fireEvent.click(button("Scan for New Receipts"));
    expect(startScan).toHaveBeenCalledWith("2030", "03", expect.any(Function));
    expect(startReconcile).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Scanning March 2030" })).toBeTruthy();
    expect(steps()).toEqual([
      "pending: Scanning receipts",
      "pending: Extracting receipt data",
      "pending: Matching",
      "pending: Reading reimbursements",
    ]);

    run.push({ step: "receipts_found", count: 2 });
    expect(steps()[0]).toBe("done: Scanning receipts · 2 found");

    await act(async () =>
      run.result.resolve({
        summary: { ...SUMMARY, bankFees: 2 },
        dropped_decisions: [{ txId: "tx-001", description: "ACME CORP", removedReceiptFiles: ["acme.pdf"] }],
      }),
    );
    expect(screen.getByRole("heading", { name: "March 2030 scanned" })).toBeTruthy();
    expect(screen.getByText("Bank fees")).toBeTruthy();
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Some review decisions were removed because their receipts are gone:");
    expect(within(banner).getByRole("listitem").textContent).toBe("ACME CORP (acme.pdf)");
  });

  it("explains a failed scan", async () => {
    vi.mocked(periodStatus).mockResolvedValue(UNFINISHED);
    const run = scanRun();
    await renderMain();
    fireEvent.click(button("Scan for New Receipts"));
    await act(async () => run.result.reject({ kind: "finalized", message: "finalized" }));
    expect(screen.getByRole("alert").textContent).toBe("This month is finalized. Re-run it to scan for receipts again.Try Again");
  });
});

describe("summary actions", () => {
  it("saves the report", async () => {
    vi.mocked(exportReport).mockResolvedValue("/Users/example/Downloads/2030-03.xlsx");
    await reconciled();
    await act(async () => fireEvent.click(button("Save Report…")));
    expect(exportReport).toHaveBeenCalledWith("2030", "03");
    expect(screen.getByRole("status").textContent).toBe("Report saved to /Users/example/Downloads/2030-03.xlsx.");
  });

  it("says nothing when saving is cancelled", async () => {
    vi.mocked(exportReport).mockResolvedValue(null);
    await reconciled();
    await act(async () => fireEvent.click(button("Save Report…")));
    expect(exportReport).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a report that cannot be saved", async () => {
    vi.mocked(exportReport).mockRejectedValue({ kind: "io", message: "disk full" });
    await reconciled();
    await act(async () => fireEvent.click(button("Save Report…")));
    expect(screen.getByRole("alert").textContent).toBe("Concilia couldn't read or write a file: disk full");
  });

  it("opens the report", async () => {
    vi.mocked(openReport).mockResolvedValue(undefined);
    await reconciled();
    await act(async () => fireEvent.click(button("Open Report")));
    expect(openReport).toHaveBeenCalledWith("2030", "03");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a report that cannot be opened", async () => {
    vi.mocked(openReport).mockRejectedValue({ kind: "not_found", message: "no report yet" });
    await reconciled();
    await act(async () => fireEvent.click(button("Open Report")));
    expect(screen.getByRole("alert").textContent).toBe("no report yet");
  });

  it("shows the period in Finder", async () => {
    vi.mocked(revealPeriod).mockResolvedValue(undefined);
    await reconciled();
    await act(async () => fireEvent.click(button("Show in Finder")));
    expect(revealPeriod).toHaveBeenCalledWith("2030", "03");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a folder that cannot be shown", async () => {
    vi.mocked(revealPeriod).mockRejectedValue(new Error("no folder"));
    await reconciled();
    await act(async () => fireEvent.click(button("Show in Finder")));
    expect(screen.getByRole("alert").textContent).toBe("Something went wrong: no folder");
  });

  it("starts a new reconciliation with no statements and no message", async () => {
    vi.mocked(exportReport).mockResolvedValue("/Users/example/Downloads/2030-03.xlsx");
    await reconciled();
    await act(async () => fireEvent.click(button("Save Report…")));
    fireEvent.click(button("New Reconciliation"));
    expect(screen.getByRole("heading", { name: "Reconcile a month" })).toBeTruthy();
    expect(screen.queryByText("extrato-2030-03.pdf")).toBeNull();
    expect(screen.getByText("Drop statement PDFs here")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(button("Reconcile").disabled).toBe(true);
  });
});
