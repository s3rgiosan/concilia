// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importServiceAccount, openSettings, pickReceiptsRoot, saveSettings, type AppStateView } from "../lib/tauri";
import { deferred, makeSettings, makeView } from "../test/fixtures";
import { Welcome } from "./Welcome";

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  importServiceAccount: vi.fn(),
  openSettings: vi.fn(),
  pickReceiptsRoot: vi.fn(),
  saveSettings: vi.fn(),
}));

const UNCONFIGURED = makeView({
  settings: makeSettings({ receipts_root: null }),
  service_account: null,
  missing: ["receipts_root", "service_account"],
  configured: false,
});

beforeEach(() => {
  vi.mocked(pickReceiptsRoot).mockResolvedValue(null);
  vi.mocked(importServiceAccount).mockResolvedValue(null);
  vi.mocked(openSettings).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderWelcome(state: AppStateView = UNCONFIGURED) {
  const onState = vi.fn();
  const onError = vi.fn();
  const result = render(<Welcome state={state} period={{ year: "2030", month: "03" }} onState={onState} onError={onError} />);
  return { ...result, onState, onError };
}

/** The settings row labelled `label`. */
function row(label: string): HTMLElement {
  return screen.getByText(label).closest<HTMLElement>(".form-row")!;
}

describe("Welcome", () => {
  it("lists what is left to set up", () => {
    const { container } = renderWelcome();
    expect(screen.getByRole("heading", { name: "Welcome to Concilia" })).toBeTruthy();
    expect(row("Receipts folder").textContent).toBe("Receipts folderNot chosenChoose…");
    expect(row("Gemini key").textContent).toBe("Gemini keyNot importedImport…");
    expect(screen.queryByText("Google Cloud project")).toBeNull();
    expect([...container.querySelectorAll(".form-row .dot")].map((d) => d.className)).toEqual(["dot dot--gray", "dot dot--gray"]);
  });

  it("shows what is already set", () => {
    const { container } = renderWelcome(makeView({ missing: [], configured: false }));
    expect(row("Receipts folder").textContent).toContain("/Users/example/Receipts");
    expect(row("Gemini key").textContent).toContain("Imported");
    expect([...container.querySelectorAll(".form-row .dot")].map((d) => d.className)).toEqual(["dot dot--green", "dot dot--green"]);
  });

  it("draws the folder layout for the month", () => {
    renderWelcome();
    const tree = screen.getByRole("list", { name: "Keep each month's receipts in a folder like this:" });
    expect(tree.textContent).toBe("Receipts203003receiptsthis month's receipts");
  });

  it("names the chosen folder at the top of the layout", () => {
    renderWelcome(makeView({ settings: makeSettings({ receipts_root: "/Users/example/Finance/" }) }));
    const tree = screen.getByRole("list", { name: "Keep each month's receipts in a folder like this:" });
    expect(tree.textContent?.startsWith("Finance2030")).toBe(true);
  });

  it("saves the folder picked", async () => {
    const saved = makeView({ missing: ["service_account"], service_account: null, configured: false });
    vi.mocked(pickReceiptsRoot).mockResolvedValue("/Users/example/Receipts");
    vi.mocked(saveSettings).mockResolvedValue(saved);
    const { onState } = renderWelcome();
    await act(async () => fireEvent.click(within(row("Receipts folder")).getByRole("button", { name: "Choose…" })));
    expect(saveSettings).toHaveBeenCalledWith({ ...UNCONFIGURED.settings, receipts_root: "/Users/example/Receipts" });
    expect(onState).toHaveBeenCalledWith(saved);
  });

  it("saves nothing when the folder picker is cancelled", async () => {
    const { onState } = renderWelcome();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Choose…" })));
    expect(saveSettings).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();
  });

  it("disables both buttons while one works", async () => {
    const picked = deferred<string | null>();
    vi.mocked(pickReceiptsRoot).mockReturnValue(picked.promise);
    renderWelcome();
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    expect((screen.getByRole("button", { name: "Working…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Import…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => picked.resolve(null));
    expect((screen.getByRole("button", { name: "Choose…" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("reports a folder that cannot be saved", async () => {
    const failure = { kind: "io", message: "denied" };
    vi.mocked(pickReceiptsRoot).mockResolvedValue("/Users/example/Receipts");
    vi.mocked(saveSettings).mockRejectedValue(failure);
    const { onError, onState } = renderWelcome();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Choose…" })));
    expect(onError).toHaveBeenCalledWith(failure);
    expect(onState).not.toHaveBeenCalled();
  });

  it("imports the key", async () => {
    const imported = makeView();
    vi.mocked(importServiceAccount).mockResolvedValue(imported);
    const { onState } = renderWelcome();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Import…" })));
    expect(importServiceAccount).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith(imported);
  });

  it("changes nothing when the import is cancelled, and reports a failed one", async () => {
    const { onState, onError } = renderWelcome();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Import…" })));
    expect(onState).not.toHaveBeenCalled();
    const failure = { kind: "keychain", message: "denied" };
    vi.mocked(importServiceAccount).mockRejectedValue(failure);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Import…" })));
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("asks for the project in Settings when the key names none", () => {
    renderWelcome(makeView({ missing: ["project"], configured: false, service_account: { client_email: "reader@acme-test.iam.gserviceaccount.com", project_id: null } }));
    expect(row("Google Cloud project").textContent).toBe("Google Cloud projectRequiredOpen Settings");
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("disables the buttons while a month is being processed", () => {
    renderWelcome({ ...UNCONFIGURED, busy: true });
    expect((screen.getByRole("button", { name: "Choose…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Import…" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
