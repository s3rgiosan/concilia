import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeView } from "../test/fixtures";

const mocks = vi.hoisted(() => {
  class Channel<T> {
    static instances: Channel<unknown>[] = [];
    onmessage: (message: T) => void = () => undefined;
    constructor() {
      Channel.instances.push(this as Channel<unknown>);
    }
  }
  return {
    invoke: vi.fn(),
    convertFileSrc: vi.fn((path: string, protocol: string) => `${protocol}://localhost/${encodeURIComponent(path)}`),
    listen: vi.fn(),
    getVersion: vi.fn(),
    setTitle: vi.fn(),
    setProgressBar: vi.fn(),
    requestUserAttention: vi.fn(),
    Channel,
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: mocks.convertFileSrc, Channel: mocks.Channel }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.getVersion }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: mocks.setTitle,
    setProgressBar: mocks.setProgressBar,
    requestUserAttention: mocks.requestUserAttention,
  }),
  ProgressBarStatus: { None: "none", Normal: "normal", Indeterminate: "indeterminate" },
  UserAttentionType: { Critical: 1, Informational: 2 },
}));

const api = await import("./tauri");

type Listener = (event: { payload: unknown }) => void;

/** Registers a listener through `register` and returns the callback handed to `listen`. */
function captureListener(register: () => Promise<unknown>): { name: string; fire: (payload: unknown) => void } {
  const unlisten = vi.fn();
  mocks.listen.mockResolvedValueOnce(unlisten);
  register();
  const [name, callback] = mocks.listen.mock.calls[mocks.listen.mock.calls.length - 1] as [string, Listener];
  return { name, fire: (payload) => callback({ payload }) };
}

beforeEach(() => {
  mocks.invoke.mockResolvedValue("result");
  mocks.Channel.instances = [];
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("command wrappers", () => {
  const settings = makeView().settings;
  const rules = [{ id: "r1", receiptVendor: "acme", transactionDescription: "acme corp" }];
  const draft = { "tx-001": { status: "MATCHED" as const } };
  const calls: [string, () => Promise<unknown>, string, unknown?][] = [
    ["getAppState", () => api.getAppState(), "get_app_state"],
    ["saveSettings", () => api.saveSettings(settings), "save_settings", { settings }],
    ["pickReceiptsRoot", () => api.pickReceiptsRoot(), "pick_receipts_root"],
    ["importServiceAccount", () => api.importServiceAccount(), "import_service_account"],
    ["removeServiceAccount", () => api.removeServiceAccount(), "remove_service_account"],
    ["testGeminiConnection", () => api.testGeminiConnection(), "test_gemini_connection"],
    ["popplerStatus", () => api.popplerStatus(), "poppler_status"],
    ["getRules", () => api.getRules(), "get_rules"],
    ["saveRules", () => api.saveRules(rules), "save_rules", { rules }],
    ["periodStatus", () => api.periodStatus("2030", "03"), "period_status", { year: "2030", month: "03" }],
    ["listPeriods", () => api.listPeriods(), "list_periods"],
    ["pickStatements", () => api.pickStatements(), "pick_statements"],
    ["cancelRun", () => api.cancelRun("2030", "03"), "cancel_run", { year: "2030", month: "03" }],
    ["getReview", () => api.getReview("2030", "03"), "get_review", { year: "2030", month: "03" }],
    ["getDraft", () => api.getDraft("2030", "03"), "get_draft", { year: "2030", month: "03" }],
    ["saveDraft", () => api.saveDraft("2030", "03", draft), "save_draft", { year: "2030", month: "03", draft }],
    ["finalize", () => api.finalize("2030", "03"), "finalize", { year: "2030", month: "03" }],
    [
      "rescanReceipt",
      () => api.rescanReceipt("2030", "03", "receipts/acme.pdf"),
      "rescan_receipt",
      { year: "2030", month: "03", relPath: "receipts/acme.pdf" },
    ],
    [
      "rescanReimbursement",
      () => api.rescanReimbursement("2030", "03", "reimbursements/acme.pdf"),
      "rescan_reimbursement",
      { year: "2030", month: "03", relPath: "reimbursements/acme.pdf" },
    ],
    ["exportReport", () => api.exportReport("2030", "03"), "export_report", { year: "2030", month: "03" }],
    ["openReport", () => api.openReport("2030", "03"), "open_report", { year: "2030", month: "03" }],
    [
      "openReceipt",
      () => api.openReceipt("2030", "03", "receipts/acme.pdf"),
      "open_receipt",
      { year: "2030", month: "03", relPath: "receipts/acme.pdf" },
    ],
    ["revealPeriod", () => api.revealPeriod("2030", "03"), "reveal_period", { year: "2030", month: "03" }],
    ["openSettings", () => api.openSettings(), "open_settings"],
    ["openKeyHelp", () => api.openKeyHelp(), "open_key_help"],
    ["periodSummary", () => api.periodSummary("2030", "03"), "period_summary", { year: "2030", month: "03" }],
    ["setMenuItemText", () => api.setMenuItemText("reject", "Remove Match"), "set_menu_item_text", { id: "reject", text: "Remove Match" }],
    ["createPeriod", () => api.createPeriod("2030", "03"), "create_period", { year: "2030", month: "03" }],
    ["checkForUpdates", () => api.checkForUpdates(), "check_for_updates"],
    ["pendingUpdate", () => api.pendingUpdate(), "pending_update"],
    ["installUpdate", () => api.installUpdate(), "install_update"],
  ];

  it.each(calls)("%s invokes its command", async (_name, call, command, args) => {
    await expect(call()).resolves.toBe("result");
    if (args === undefined) {
      expect(mocks.invoke).toHaveBeenCalledWith(command);
    } else {
      expect(mocks.invoke).toHaveBeenCalledWith(command, args);
    }
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("passes command failures through", async () => {
    const failure = { kind: "network", message: "offline" };
    mocks.invoke.mockRejectedValue(failure);
    await expect(api.getAppState()).rejects.toBe(failure);
  });
});

describe("startReconcile", () => {
  it("streams events through a channel and resolves to the command's result", async () => {
    const onEvent = vi.fn();
    const statements = [{ path: "/Users/example/statement.pdf", bank: "cgd" }];
    const handle = api.startReconcile("2030", "03", statements, true, onEvent);

    await expect(handle.promise).resolves.toBe("result");
    expect(mocks.Channel.instances).toHaveLength(1);
    const channel = mocks.Channel.instances[0];
    expect(channel.onmessage).toBe(onEvent);
    expect(mocks.invoke).toHaveBeenCalledWith("reconcile", {
      year: "2030",
      month: "03",
      statements,
      clearCache: true,
      onEvent: channel,
    });

    channel.onmessage({ step: "parsing", count: 1 });
    expect(onEvent).toHaveBeenCalledWith({ step: "parsing", count: 1 });
  });

  it("cancels the month's run", async () => {
    const handle = api.startReconcile("2030", "03", [], false, () => undefined);
    mocks.invoke.mockClear();
    mocks.invoke.mockResolvedValue(true);
    await expect(handle.cancel()).resolves.toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("cancel_run", { year: "2030", month: "03" });
  });
});

describe("startScan", () => {
  it("invokes scan_receipts with a channel", async () => {
    const onEvent = vi.fn();
    const handle = api.startScan("2030", "04", onEvent);
    await handle.promise;
    const channel = mocks.Channel.instances[0];
    expect(channel.onmessage).toBe(onEvent);
    expect(mocks.invoke).toHaveBeenCalledWith("scan_receipts", { year: "2030", month: "04", onEvent: channel });

    mocks.invoke.mockClear();
    await handle.cancel();
    expect(mocks.invoke).toHaveBeenCalledWith("cancel_run", { year: "2030", month: "04" });
  });
});

describe("appVersion", () => {
  it("reads the app version", async () => {
    mocks.getVersion.mockResolvedValue("2.0.0");
    await expect(api.appVersion()).resolves.toBe("2.0.0");
  });
});

describe("setWindowTitle", () => {
  it("sets the current window's title", async () => {
    mocks.setTitle.mockResolvedValue(undefined);
    await api.setWindowTitle("March 2030");
    expect(mocks.setTitle).toHaveBeenCalledWith("March 2030");
  });
});

describe("menu commands", () => {
  it("sends the labels", async () => {
    await api.setMenu({ menu_file: "Ficheiro" }, [{ id: "salary", label: "Salário" }]);
    expect(mocks.invoke).toHaveBeenCalledWith("set_menu", { labels: { menu_file: "Ficheiro" }, reasons: [{ id: "salary", label: "Salário" }] });
  });

  it("sends the enabled map", async () => {
    await api.setMenuState({ accept: false });
    expect(mocks.invoke).toHaveBeenCalledWith("set_menu_state", { enabled: { accept: false } });
  });
});

describe("dock", () => {
  beforeEach(() => mocks.setProgressBar.mockResolvedValue(undefined));

  it("shows a percentage", async () => {
    await api.setDockProgress(42.4);
    expect(mocks.setProgressBar).toHaveBeenCalledWith({ status: "normal", progress: 42 });
  });

  it("clamps the percentage", async () => {
    await api.setDockProgress(140);
    expect(mocks.setProgressBar).toHaveBeenCalledWith({ status: "normal", progress: 100 });
  });

  it("shows an indeterminate bar", async () => {
    await api.setDockProgress("indeterminate");
    expect(mocks.setProgressBar).toHaveBeenCalledWith({ status: "indeterminate" });
  });

  it("clears the bar", async () => {
    await api.setDockProgress(null);
    expect(mocks.setProgressBar).toHaveBeenCalledWith({ status: "none" });
  });

  it("requests informational attention", async () => {
    mocks.requestUserAttention.mockResolvedValue(undefined);
    await api.requestAttention();
    expect(mocks.requestUserAttention).toHaveBeenCalledWith(2);
  });
});

describe("receiptUrl", () => {
  it("encodes the period-relative path on the receipt scheme", () => {
    expect(api.receiptUrl("2030/03/receipts/acme.pdf")).toBe("receipt://localhost/2030%2F03%2Freceipts%2Facme.pdf");
    expect(mocks.convertFileSrc).toHaveBeenCalledWith("2030/03/receipts/acme.pdf", "receipt");
  });
});

describe("event listeners", () => {
  it("passes a valid settings-changed payload on", () => {
    const handler = vi.fn();
    const { name, fire } = captureListener(() => api.onSettingsChanged(handler));
    expect(name).toBe(api.SETTINGS_CHANGED_EVENT);
    const view = makeView();
    fire(view);
    expect(handler).toHaveBeenCalledWith(view);
  });

  it("drops a malformed settings-changed payload", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = vi.fn();
    const { fire } = captureListener(() => api.onSettingsChanged(handler));
    fire({ settings: null });
    fire(null);
    expect(handler).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("maps busy-changed to a boolean", () => {
    const handler = vi.fn();
    const { name, fire } = captureListener(() => api.onBusyChanged(handler));
    expect(name).toBe(api.BUSY_CHANGED_EVENT);
    fire({ busy: true });
    fire({ busy: false });
    fire({ busy: "yes" });
    fire(null);
    expect(handler.mock.calls).toEqual([[true], [false], [false], [false]]);
  });

  it("passes the id of a chosen menu item on", () => {
    const handler = vi.fn();
    const { name, fire } = captureListener(() => api.onMenu(handler));
    expect(name).toBe(api.MENU_EVENT);
    fire({ id: "accept" });
    expect(handler).toHaveBeenCalledExactlyOnceWith("accept");
  });

  it("drops a malformed menu payload", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = vi.fn();
    const { fire } = captureListener(() => api.onMenu(handler));
    fire({ id: 3 });
    fire(null);
    expect(handler).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("passes update progress on", () => {
    const handler = vi.fn();
    const { name, fire } = captureListener(() => api.onUpdateProgress(handler));
    expect(name).toBe(api.UPDATE_PROGRESS_EVENT);
    fire({ downloaded: 10, total: 100 });
    expect(handler).toHaveBeenCalledWith({ downloaded: 10, total: 100 });
  });

  it("passes update check results on", () => {
    const handler = vi.fn();
    const { name, fire } = captureListener(() => api.onUpdateCheckResult(handler));
    expect(name).toBe(api.UPDATE_CHECK_RESULT_EVENT);
    const result = { update: { version: "9.9.9", notes: null }, error: null, manual: false };
    fire(result);
    expect(handler).toHaveBeenCalledWith(result);
  });

  it("resolves to the unlisten function", async () => {
    const unlisten = vi.fn();
    mocks.listen.mockResolvedValueOnce(unlisten);
    await expect(api.onBusyChanged(() => undefined)).resolves.toBe(unlisten);
  });
});

describe("subscribe", () => {
  it("unlistens on cleanup after registration", async () => {
    const unlisten = vi.fn();
    const stop = api.subscribe(Promise.resolve(unlisten));
    await Promise.resolve();
    await Promise.resolve();
    expect(unlisten).not.toHaveBeenCalled();
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("unlistens as soon as a registration resolves after cleanup", async () => {
    const unlisten = vi.fn();
    let resolve!: (fn: () => void) => void;
    const stop = api.subscribe(new Promise((res) => (resolve = res)));
    stop();
    expect(unlisten).not.toHaveBeenCalled();
    resolve(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it("logs a failed registration", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stop = api.subscribe(Promise.reject(new Error("no ipc")));
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("could not register event listener", expect.any(Error)));
    expect(() => stop()).not.toThrow();
  });
});
