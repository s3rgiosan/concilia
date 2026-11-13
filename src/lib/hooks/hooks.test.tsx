// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { deferred, makeSettings, makeView } from "../../test/fixtures";
import { getAppState, installUpdate, onBusyChanged, onSettingsChanged, onUpdateProgress, type AppStateView, type UpdateProgress } from "../tauri";
import { useAppState } from "./useAppState";
import { useInstallUpdate } from "./useInstallUpdate";

vi.mock("../tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tauri")>()),
  getAppState: vi.fn(),
  installUpdate: vi.fn(),
  onSettingsChanged: vi.fn(),
  onBusyChanged: vi.fn(),
  onUpdateProgress: vi.fn(),
}));

let pushSettings: (view: AppStateView) => void;
let pushBusy: (busy: boolean) => void;
let pushProgress: (progress: UpdateProgress) => void;
const unlistenSettings = vi.fn();
const unlistenBusy = vi.fn();

beforeEach(() => {
  vi.mocked(onSettingsChanged).mockImplementation((handler) => {
    pushSettings = handler;
    return Promise.resolve(unlistenSettings);
  });
  vi.mocked(onBusyChanged).mockImplementation((handler) => {
    pushBusy = handler;
    return Promise.resolve(unlistenBusy);
  });
  vi.mocked(onUpdateProgress).mockImplementation((handler) => {
    pushProgress = handler;
    return Promise.resolve(() => undefined);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("useAppState", () => {
  it("loads the state and applies its language", async () => {
    const changeLanguage = vi.spyOn(i18n, "changeLanguage").mockResolvedValue(i18n.t);
    const view = makeView({ settings: makeSettings({ language: "en" }) });
    vi.mocked(getAppState).mockResolvedValue(view);
    const { result } = renderHook(() => useAppState());
    expect(result.current.state).toBeNull();
    await waitFor(() => expect(result.current.state).toEqual(view));
    expect(result.current.error).toBeNull();
    expect(changeLanguage).toHaveBeenCalledWith("en");
  });

  it("starts from the state read at launch and does not read it again", async () => {
    const view = makeView();
    const { result } = renderHook(() => useAppState(view));
    expect(result.current.state).toBe(view);
    await act(async () => undefined);
    expect(getAppState).not.toHaveBeenCalled();

    const next = makeView({ settings: makeSettings({ language: "en", receipts_root: "/Users/example/Other" }) });
    vi.spyOn(i18n, "changeLanguage").mockResolvedValue(i18n.t);
    act(() => pushSettings(next));
    expect(result.current.state).toEqual(next);
  });

  it("reads the state again on reload even when it started from one", async () => {
    vi.spyOn(i18n, "changeLanguage").mockResolvedValue(i18n.t);
    const next = makeView({ configured: false });
    vi.mocked(getAppState).mockResolvedValue(next);
    const { result } = renderHook(() => useAppState(makeView()));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.state).toEqual(next));
    expect(getAppState).toHaveBeenCalledTimes(1);
  });

  it("replaces the state on settings-changed and applies the new language", async () => {
    const changeLanguage = vi.spyOn(i18n, "changeLanguage").mockResolvedValue(i18n.t);
    vi.mocked(getAppState).mockResolvedValue(makeView());
    const { result } = renderHook(() => useAppState());
    await waitFor(() => expect(result.current.state).not.toBeNull());

    const next = makeView({ settings: makeSettings({ language: "pt", receipts_root: "/Users/example/Other" }) });
    act(() => pushSettings(next));
    expect(result.current.state).toEqual(next);
    expect(changeLanguage).toHaveBeenLastCalledWith("pt");
    expect(document.documentElement.lang).toBe("pt");
  });

  it("logs a language change that fails", async () => {
    vi.spyOn(i18n, "changeLanguage").mockRejectedValue(new Error("no bundle"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(getAppState).mockResolvedValue(makeView());
    renderHook(() => useAppState());
    await waitFor(() => expect(error).toHaveBeenCalledWith("could not change language", expect.any(Error)));
  });

  it("replace sets the state from a command result", async () => {
    vi.spyOn(i18n, "changeLanguage").mockResolvedValue(i18n.t);
    vi.mocked(getAppState).mockResolvedValue(makeView());
    const { result } = renderHook(() => useAppState());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    const next = makeView({ service_account: null });
    act(() => result.current.replace(next));
    expect(result.current.state).toEqual(next);
  });

  it("toggles busy on busy-changed", async () => {
    vi.spyOn(i18n, "changeLanguage").mockResolvedValue(i18n.t);
    vi.mocked(getAppState).mockResolvedValue(makeView());
    const { result } = renderHook(() => useAppState());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    act(() => pushBusy(true));
    expect(result.current.state?.busy).toBe(true);
    act(() => pushBusy(false));
    expect(result.current.state?.busy).toBe(false);
  });

  it("ignores busy-changed before the state loads", () => {
    vi.mocked(getAppState).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => useAppState());
    act(() => pushBusy(true));
    expect(result.current.state).toBeNull();
  });

  it("reports a load error and clears it on a successful reload", async () => {
    vi.spyOn(i18n, "changeLanguage").mockResolvedValue(i18n.t);
    const failure = { kind: "io", message: "unreadable" };
    vi.mocked(getAppState).mockRejectedValueOnce(failure);
    const { result } = renderHook(() => useAppState());
    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(result.current.state).toBeNull();

    const view = makeView();
    vi.mocked(getAppState).mockResolvedValueOnce(view);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.state).toEqual(view));
    expect(result.current.error).toBeNull();
    expect(getAppState).toHaveBeenCalledTimes(2);
  });

  it("stops listening on unmount", async () => {
    vi.spyOn(i18n, "changeLanguage").mockResolvedValue(i18n.t);
    vi.mocked(getAppState).mockResolvedValue(makeView());
    const { result, unmount } = renderHook(() => useAppState());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    unmount();
    expect(unlistenSettings).toHaveBeenCalled();
    expect(unlistenBusy).toHaveBeenCalled();
  });
});

describe("useInstallUpdate", () => {
  it("labels each phase of the install", async () => {
    const install = deferred<void>();
    vi.mocked(installUpdate).mockReturnValue(install.promise);
    const { result } = renderHook(() => useInstallUpdate(() => undefined));
    expect(result.current.label).toBe("Install and Relaunch");
    expect(result.current.busy).toBe(false);

    act(() => result.current.install());
    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(true);
    expect(result.current.label).toBe("Downloading…");

    act(() => pushProgress({ downloaded: 50, total: null }));
    expect(result.current.label).toBe("Downloading…");

    act(() => pushProgress({ downloaded: 0, total: 0 }));
    expect(result.current.label).toBe("Downloading…");

    act(() => pushProgress({ downloaded: 50, total: 100 }));
    expect(result.current.label).toBe("Downloading… 50%");

    act(() => pushProgress({ downloaded: 999, total: 1000 }));
    expect(result.current.label).toBe("Downloading… 99%");

    act(() => pushProgress({ downloaded: 100, total: 100 }));
    expect(result.current.label).toBe("Installing…");
    expect(result.current.busy).toBe(true);
  });

  it("ignores progress while idle", () => {
    const { result } = renderHook(() => useInstallUpdate(() => undefined));
    act(() => pushProgress({ downloaded: 50, total: 100 }));
    expect(result.current.label).toBe("Install and Relaunch");
    expect(result.current.busy).toBe(false);
  });

  it("resets and reports a failed install", async () => {
    const failure = { kind: "network", message: "offline" };
    vi.mocked(installUpdate).mockRejectedValue(failure);
    const onError = vi.fn();
    const { result } = renderHook(() => useInstallUpdate(onError));
    act(() => result.current.install());
    await waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
    expect(result.current.busy).toBe(false);
    expect(result.current.label).toBe("Install and Relaunch");
  });

  it("reports through the latest onError", async () => {
    const install = deferred<void>();
    vi.mocked(installUpdate).mockReturnValue(install.promise);
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(({ onError }) => useInstallUpdate(onError), { initialProps: { onError: first } });
    act(() => result.current.install());
    rerender({ onError: second });
    await act(async () => install.reject(new Error("broken")));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(new Error("broken"));
  });
});
