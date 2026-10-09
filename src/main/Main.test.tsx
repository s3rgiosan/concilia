// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAppState,
  installUpdate,
  onBusyChanged,
  onSettingsChanged,
  onUpdateCheckResult,
  onUpdateProgress,
  openSettings,
  pendingUpdate,
  type AppStateView,
  type UpdateCheckResult,
  type UpdateProgress,
} from "../lib/tauri";
import { deferred, makeSettings, makeView } from "../test/fixtures";
import { Main } from "./Main";

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  getAppState: vi.fn(),
  installUpdate: vi.fn(),
  onBusyChanged: vi.fn(),
  onSettingsChanged: vi.fn(),
  onUpdateCheckResult: vi.fn(),
  onUpdateProgress: vi.fn(),
  openSettings: vi.fn(),
  pendingUpdate: vi.fn(),
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

beforeEach(() => {
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
