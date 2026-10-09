// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import {
  appVersion,
  checkForUpdates,
  getAppState,
  getRules,
  importServiceAccount,
  onBusyChanged,
  onSettingsChanged,
  pickReceiptsRoot,
  popplerStatus,
  removeServiceAccount,
  saveRules,
  saveSettings,
  testGeminiConnection,
  type AppStateView,
  type Settings as SettingsData,
} from "../lib/tauri";
import { ACCOUNT, deferred, makeRule, makeSettings, makeView } from "../test/fixtures";
import { Settings } from "./Settings";

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  appVersion: vi.fn(),
  checkForUpdates: vi.fn(),
  getAppState: vi.fn(),
  getRules: vi.fn(),
  importServiceAccount: vi.fn(),
  onBusyChanged: vi.fn(),
  onSettingsChanged: vi.fn(),
  pickReceiptsRoot: vi.fn(),
  popplerStatus: vi.fn(),
  removeServiceAccount: vi.fn(),
  saveRules: vi.fn(),
  saveSettings: vi.fn(),
  testGeminiConnection: vi.fn(),
}));

let pushSettings: (view: AppStateView) => void;
let pushBusy: (busy: boolean) => void;
/** The view the window loaded; saved settings are echoed back on top of it. */
let current: AppStateView;

beforeEach(() => {
  localStorage.clear();
  vi.mocked(onSettingsChanged).mockImplementation((handler) => {
    pushSettings = handler;
    return Promise.resolve(() => undefined);
  });
  vi.mocked(onBusyChanged).mockImplementation((handler) => {
    pushBusy = handler;
    return Promise.resolve(() => undefined);
  });
  vi.mocked(saveSettings).mockImplementation((settings) => Promise.resolve({ ...current, settings }));
  vi.mocked(appVersion).mockResolvedValue("2.0.0");
  vi.mocked(popplerStatus).mockResolvedValue({ version: "24.02.0", bundled: true });
  vi.mocked(getRules).mockResolvedValue([]);
  vi.mocked(saveRules).mockImplementation((rules) => Promise.resolve(rules));
});

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

async function renderSettings(view: AppStateView = makeView(), pane?: string) {
  current = view;
  if (pane) {
    localStorage.setItem("settings.pane", pane);
  }
  vi.mocked(getAppState).mockResolvedValue(view);
  const result = render(<Settings />);
  await screen.findByRole("navigation", { name: "Settings" });
  return result;
}

function tab(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

/** The settings passed to the last `saveSettings` call. */
function lastSaved(): SettingsData {
  const calls = vi.mocked(saveSettings).mock.calls;
  return calls[calls.length - 1][0];
}

function commitText(label: string, value: string) {
  const input = field(label);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe("Settings window", () => {
  it("sets the window title", async () => {
    await renderSettings();
    expect(document.title).toBe("Settings");
  });

  it("opens on General and switches panes", async () => {
    await renderSettings();
    expect(tab("General").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Language")).toBeTruthy();

    fireEvent.click(tab("Folder"));
    expect(tab("Folder").getAttribute("aria-pressed")).toBe("true");
    expect(tab("General").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Receipts folder")).toBeTruthy();
    expect(screen.queryByLabelText("Language")).toBeNull();

    fireEvent.click(tab("Gemini"));
    expect(screen.getByText("Service account key")).toBeTruthy();

    fireEvent.click(tab("Rules"));
    expect(await screen.findByText("No rules yet.")).toBeTruthy();
  });

  it("remembers the pane", async () => {
    const { unmount } = await renderSettings();
    fireEvent.click(tab("Gemini"));
    expect(localStorage.getItem("settings.pane")).toBe("gemini");
    unmount();
    await renderSettings();
    expect(tab("Gemini").getAttribute("aria-pressed")).toBe("true");
  });

  it("opens on General when the stored pane is unknown", async () => {
    await renderSettings(makeView(), "advanced");
    expect(tab("General").getAttribute("aria-pressed")).toBe("true");
  });

  it("works when storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    await renderSettings();
    expect(tab("General").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(tab("Folder"));
    expect(tab("Folder").getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a load error with Try Again", async () => {
    vi.mocked(getAppState).mockRejectedValueOnce({ kind: "io", message: "settings.json unreadable" });
    render(<Settings />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Concilia couldn't read or write a file: settings.json unreadable");

    current = makeView();
    vi.mocked(getAppState).mockResolvedValueOnce(current);
    fireEvent.click(button("Try Again"));
    expect(await screen.findByRole("navigation", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders nothing until the state loads", () => {
    vi.mocked(getAppState).mockReturnValue(new Promise(() => undefined));
    const { container } = render(<Settings />);
    expect(container.innerHTML).toBe("");
  });

  it("shows a read-only banner and disables the controls", async () => {
    await renderSettings(makeView({ read_only: true }));
    expect(screen.getByText("These settings were saved by a newer version of Concilia and can't be changed here.")).toBeTruthy();
    expect((screen.getByLabelText("Language") as HTMLSelectElement).disabled).toBe(true);
    expect(field("Check for updates automatically").disabled).toBe(true);
  });

  it("shows the busy banner on the Folder and Gemini panes only", async () => {
    const busyText = "The folder and Gemini settings can't change while a month is being processed.";
    await renderSettings(makeView({ busy: true }));
    expect(screen.queryByText(busyText)).toBeNull();
    fireEvent.click(tab("Folder"));
    expect(screen.getByText(busyText)).toBeTruthy();
    fireEvent.click(tab("Gemini"));
    expect(screen.getByText(busyText)).toBeTruthy();
    fireEvent.click(tab("Rules"));
    expect(screen.queryByText(busyText)).toBeNull();
  });

  it("follows busy-changed and settings-changed events", async () => {
    await renderSettings(makeView(), "folder");
    const choose = button("Choose…");
    expect(choose.disabled).toBe(false);
    act(() => pushBusy(true));
    expect(choose.disabled).toBe(true);
    act(() => pushBusy(false));
    expect(choose.disabled).toBe(false);

    act(() => pushSettings(makeView({ settings: makeSettings({ receipts_root: "/Users/example/Elsewhere" }) })));
    expect(screen.getByText("/Users/example/Elsewhere")).toBeTruthy();
  });

  it("shows a save failure and clears it on the next save or pane switch", async () => {
    await renderSettings();
    vi.mocked(saveSettings).mockRejectedValueOnce({ kind: "read_only", message: "" });
    fireEvent.click(field("Check for updates automatically"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The settings were saved by a newer version of Concilia and are read-only.");

    fireEvent.click(field("Check for updates automatically"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    vi.mocked(saveSettings).mockRejectedValueOnce(new Error("disk full"));
    fireEvent.click(field("Check for updates automatically"));
    await screen.findByRole("alert");
    fireEvent.click(tab("Folder"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("General pane", () => {
  it.each([
    ["pt", "pt"],
    ["en", "en"],
    ["system", null],
  ] as const)("saves the language choice %s", async (choice, saved) => {
    await renderSettings(makeView({ settings: makeSettings({ language: choice === "system" ? "en" : null }) }));
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: choice } });
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(lastSaved()).toEqual({ ...current.settings, language: saved });
  });

  it("shows the saved language", async () => {
    const changeLanguage = vi.spyOn(i18n, "changeLanguage").mockResolvedValue(i18n.t);
    await renderSettings(makeView({ settings: makeSettings({ language: "pt" }) }));
    expect((screen.getByLabelText("Language") as HTMLSelectElement).value).toBe("pt");
    expect(changeLanguage).toHaveBeenCalledWith("pt");
  });

  it("shows Same as System when no language is saved", async () => {
    await renderSettings();
    expect((screen.getByLabelText("Language") as HTMLSelectElement).value).toBe("system");
    expect(screen.getAllByText("Same as System").length).toBeGreaterThan(0);
  });

  it("saves the update switch", async () => {
    await renderSettings();
    const toggle = field("Check for updates automatically");
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(lastSaved()).toEqual({ ...current.settings, check_for_updates: false });
  });

  it("shows the app version", async () => {
    await renderSettings();
    expect(await screen.findByText("Version 2.0.0")).toBeTruthy();
  });

  it("reports a failure to read the version", async () => {
    vi.mocked(appVersion).mockRejectedValue(new Error("no app"));
    await renderSettings();
    expect((await screen.findByRole("alert")).textContent).toBe("Something went wrong: no app");
  });

  it("says when Concilia is up to date", async () => {
    const check = deferred<null>();
    vi.mocked(checkForUpdates).mockReturnValue(check.promise);
    await renderSettings();
    fireEvent.click(button("Check Now"));
    expect(button("Checking…").disabled).toBe(true);
    await act(async () => check.resolve(null));
    expect(screen.getByText("Concilia is up to date.")).toBeTruthy();
    expect(button("Check Now").disabled).toBe(false);
  });

  it("names an available update", async () => {
    vi.mocked(checkForUpdates).mockResolvedValue({ version: "9.9.9", notes: null });
    await renderSettings();
    fireEvent.click(button("Check Now"));
    expect(await screen.findByText("Concilia 9.9.9 is available.")).toBeTruthy();
  });

  it("shows a failed check", async () => {
    vi.mocked(checkForUpdates).mockRejectedValue({ kind: "network", message: "offline" });
    await renderSettings();
    fireEvent.click(button("Check Now"));
    expect(await screen.findByText("Concilia can't reach the server. Check your internet connection.")).toBeTruthy();
    expect(button("Check Now").disabled).toBe(false);
  });

  it("keeps Check Now enabled when read-only", async () => {
    await renderSettings(makeView({ read_only: true }));
    expect(button("Check Now").disabled).toBe(false);
  });

  it("shows the bundled PDF tools", async () => {
    await renderSettings();
    expect(await screen.findByText("poppler 24.02.0, included with Concilia")).toBeTruthy();
  });

  it("shows system PDF tools", async () => {
    vi.mocked(popplerStatus).mockResolvedValue({ version: "25.01.0", bundled: false });
    await renderSettings();
    expect(await screen.findByText("poppler 25.01.0")).toBeTruthy();
  });

  it("shows missing PDF tools", async () => {
    vi.mocked(popplerStatus).mockRejectedValue({ kind: "poppler_missing", message: "" });
    await renderSettings();
    expect(await screen.findByText("The PDF tools Concilia needs are missing. Reinstall Concilia.")).toBeTruthy();
  });

  it("shows Loading… while the PDF tools are checked", async () => {
    vi.mocked(popplerStatus).mockReturnValue(new Promise(() => undefined));
    await renderSettings();
    expect(screen.getByText("Loading…")).toBeTruthy();
  });
});

describe("Folder pane", () => {
  it("shows the receipts folder", async () => {
    await renderSettings(makeView(), "folder");
    const path = screen.getByText("/Users/example/Receipts");
    expect(path.getAttribute("title")).toBe("/Users/example/Receipts");
    expect(screen.queryByText("This folder no longer exists. Choose it again.")).toBeNull();
  });

  it("says when no folder is chosen", async () => {
    await renderSettings(makeView({ settings: makeSettings({ receipts_root: null }), missing: ["receipts_root"] }), "folder");
    expect(screen.getByText("Not chosen").getAttribute("title")).toBeNull();
    expect(screen.queryByText("This folder no longer exists. Choose it again.")).toBeNull();
  });

  it("warns when the chosen folder is missing", async () => {
    await renderSettings(makeView({ missing: ["receipts_root"] }), "folder");
    expect(screen.getByText("This folder no longer exists. Choose it again.")).toBeTruthy();
  });

  it("saves the picked folder", async () => {
    vi.mocked(pickReceiptsRoot).mockResolvedValue("/Users/example/New Receipts");
    await renderSettings(makeView(), "folder");
    fireEvent.click(button("Choose…"));
    expect(await screen.findByText("/Users/example/New Receipts")).toBeTruthy();
    expect(lastSaved()).toEqual({ ...current.settings, receipts_root: "/Users/example/New Receipts" });
  });

  it("does nothing when the dialog is cancelled", async () => {
    vi.mocked(pickReceiptsRoot).mockResolvedValue(null);
    await renderSettings(makeView(), "folder");
    fireEvent.click(button("Choose…"));
    await waitFor(() => expect(pickReceiptsRoot).toHaveBeenCalled());
    await act(async () => undefined);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("reports a failed pick", async () => {
    vi.mocked(pickReceiptsRoot).mockRejectedValue({ kind: "internal", message: "dialog crashed" });
    await renderSettings(makeView(), "folder");
    fireEvent.click(button("Choose…"));
    expect((await screen.findByRole("alert")).textContent).toBe("Something went wrong: dialog crashed");
  });

  it.each([
    ["busy", { busy: true }],
    ["read-only", { read_only: true }],
  ])("disables Choose… when %s", async (_name, patch) => {
    await renderSettings(makeView(patch), "folder");
    expect(button("Choose…").disabled).toBe(true);
  });
});

describe("Gemini pane", () => {
  it("shows the imported key", async () => {
    await renderSettings(makeView(), "gemini");
    expect(screen.getByText(ACCOUNT.client_email)).toBeTruthy();
    expect(button("Replace…")).toBeTruthy();
    expect(button("Remove")).toBeTruthy();
    expect(field("Project").placeholder).toBe("acme-test (from the key)");
  });

  it("asks for a key and a project when none is imported", async () => {
    await renderSettings(makeView({ service_account: null }), "gemini");
    expect(screen.getByText("No key imported")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(button("Import Key File…")).toBeTruthy();
    expect(field("Project").placeholder).toBe("Required");
    expect(button("Test Connection").disabled).toBe(true);
  });

  it("asks for a project when the key names none", async () => {
    await renderSettings(makeView({ service_account: { ...ACCOUNT, project_id: null } }), "gemini");
    expect(field("Project").placeholder).toBe("Required");
  });

  it("explains an unreadable key", async () => {
    await renderSettings(makeView({ service_account: null, service_account_error: "item not found" }), "gemini");
    expect(screen.getByText("Concilia can't read the stored key: item not found")).toBeTruthy();
  });

  it("imports a key and shows the new state", async () => {
    const imported = makeView({ service_account: { client_email: "writer@acme-test.iam.gserviceaccount.com", project_id: "acme-test" } });
    vi.mocked(importServiceAccount).mockResolvedValue(imported);
    await renderSettings(makeView({ service_account: null }), "gemini");
    fireEvent.click(button("Import Key File…"));
    expect(await screen.findByText("writer@acme-test.iam.gserviceaccount.com")).toBeTruthy();
    expect(button("Replace…")).toBeTruthy();
  });

  it("keeps the key when the import is cancelled", async () => {
    vi.mocked(importServiceAccount).mockResolvedValue(null);
    await renderSettings(makeView(), "gemini");
    fireEvent.click(button("Replace…"));
    await waitFor(() => expect(importServiceAccount).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.getByText(ACCOUNT.client_email)).toBeTruthy();
  });

  it("reports a failed import", async () => {
    vi.mocked(importServiceAccount).mockRejectedValue({ kind: "invalid_input", message: "Not a service account key." });
    await renderSettings(makeView(), "gemini");
    fireEvent.click(button("Replace…"));
    expect((await screen.findByRole("alert")).textContent).toBe("Not a service account key.");
  });

  it("removes the key after confirmation", async () => {
    const removed = deferred<AppStateView>();
    vi.mocked(removeServiceAccount).mockReturnValue(removed.promise);
    await renderSettings(makeView(), "gemini");
    fireEvent.click(button("Remove"));
    const sheet = screen.getByRole("alertdialog", { name: "Remove the service account key?" });
    expect(sheet.textContent).toContain("Concilia can't read receipts until you import a key again.");

    fireEvent.click(within(sheet).getByRole("button", { name: "Remove" }));
    expect(removeServiceAccount).toHaveBeenCalledTimes(1);
    expect((within(sheet).getByRole("button", { name: "Working…" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => removed.resolve(makeView({ service_account: null })));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText("No key imported")).toBeTruthy();
  });

  it("keeps the key when removal is cancelled", async () => {
    await renderSettings(makeView(), "gemini");
    fireEvent.click(button("Remove"));
    const sheet = screen.getByRole("alertdialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(removeServiceAccount).not.toHaveBeenCalled();
  });

  it("reports a failed removal and keeps the sheet open", async () => {
    vi.mocked(removeServiceAccount).mockRejectedValue({ kind: "keychain", message: "locked" });
    await renderSettings(makeView(), "gemini");
    fireEvent.click(button("Remove"));
    const sheet = screen.getByRole("alertdialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "Remove" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Concilia can't use the Keychain: locked");
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect((within(sheet).getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("saves a trimmed project", async () => {
    await renderSettings(makeView(), "gemini");
    commitText("Project", "  acme-billing ");
    expect(lastSaved()).toEqual({ ...current.settings, gemini: { ...current.settings.gemini, project: "acme-billing" } });
  });

  it("saves an empty project as null", async () => {
    await renderSettings(makeView({ settings: makeSettings({ gemini: { project: "acme-billing", location: "europe-west1", model: "gemini-2.5-flash" } }) }), "gemini");
    expect(field("Project").value).toBe("acme-billing");
    commitText("Project", "   ");
    expect(lastSaved().gemini.project).toBeNull();
  });

  it("saves a trimmed location and model", async () => {
    await renderSettings(makeView(), "gemini");
    expect(field("Location").value).toBe("europe-west1");
    expect(field("Model").value).toBe("gemini-2.5-flash");
    commitText("Location", " us-central1 ");
    expect(lastSaved().gemini).toEqual({ project: null, location: "us-central1", model: "gemini-2.5-flash" });
    commitText("Model", "gemini-2.5-pro ");
    await waitFor(() => expect(lastSaved().gemini.model).toBe("gemini-2.5-pro"));
    expect(lastSaved().gemini.location).toBe("us-central1");
  });

  it("does not save an unchanged field", async () => {
    await renderSettings(makeView(), "gemini");
    commitText("Location", "europe-west1");
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("keeps an earlier change when two saves overlap", async () => {
    const first = deferred<AppStateView>();
    vi.mocked(saveSettings).mockReturnValueOnce(first.promise);
    await renderSettings(makeView(), "gemini");
    commitText("Project", "acme-billing");
    commitText("Location", "us-central1");
    // The second save waits for the first, then builds on it.
    expect(saveSettings).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(makeView()));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2));
    expect(lastSaved().gemini).toEqual({ project: "acme-billing", location: "us-central1", model: "gemini-2.5-flash" });
  });

  it.each([
    ["busy", { busy: true }],
    ["read-only", { read_only: true }],
  ])("locks the key and fields when %s", async (_name, patch) => {
    await renderSettings(makeView(patch), "gemini");
    expect(button("Remove").disabled).toBe(true);
    expect(button("Replace…").disabled).toBe(true);
    expect(field("Project").disabled).toBe(true);
    expect(field("Location").disabled).toBe(true);
    expect(field("Model").disabled).toBe(true);
    expect(button("Test Connection").disabled).toBe(false);
  });

  it("reports a working connection", async () => {
    const test = deferred<void>();
    vi.mocked(testGeminiConnection).mockReturnValue(test.promise);
    await renderSettings(makeView(), "gemini");
    fireEvent.click(button("Test Connection"));
    expect(button("Testing…").disabled).toBe(true);
    await act(async () => test.resolve());
    expect(screen.getByText("Concilia reached Google with this key.")).toBeTruthy();
    expect(button("Test Connection").disabled).toBe(false);
  });

  it("reports a failed connection", async () => {
    vi.mocked(testGeminiConnection).mockRejectedValue({ kind: "unauthorized", message: "" });
    await renderSettings(makeView(), "gemini");
    fireEvent.click(button("Test Connection"));
    expect(
      await screen.findByText("Google refused the service account. Check the key and the project, and that the Vertex AI API is enabled."),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears the test result when a key is imported", async () => {
    vi.mocked(testGeminiConnection).mockResolvedValue(undefined);
    vi.mocked(importServiceAccount).mockResolvedValue(null);
    await renderSettings(makeView(), "gemini");
    fireEvent.click(button("Test Connection"));
    await screen.findByText("Concilia reached Google with this key.");
    fireEvent.click(button("Replace…"));
    expect(screen.queryByText("Concilia reached Google with this key.")).toBeNull();
  });
});

describe("Rules pane", () => {
  const rules = [
    makeRule({ id: "rule-1", receiptVendor: "acme", transactionDescription: "acme corp" }),
    makeRule({ id: "rule-2", receiptVendor: "globex", transactionDescription: "globex ltd" }),
  ];

  function rows(): HTMLElement[] {
    return within(screen.getByRole("table")).getAllByRole("row").slice(1);
  }

  async function renderRules(initial = rules) {
    vi.mocked(getRules).mockResolvedValue(initial);
    await renderSettings(makeView(), "rules");
    await screen.findByRole("region", { name: "Match rules" });
  }

  function sheetInput(label: string): HTMLInputElement {
    return within(screen.getByRole("dialog")).getByLabelText(label) as HTMLInputElement;
  }

  it("lists the rules", async () => {
    await renderRules();
    expect(rows().map((row) => row.textContent)).toEqual(["acmeacme corp", "globexglobex ltd"]);
  });

  it("says when there are no rules", async () => {
    await renderRules([]);
    expect(screen.getByText("No rules yet.")).toBeTruthy();
    expect(button("Delete Rule").disabled).toBe(true);
  });

  it("adds a rule with a generated id once both keywords are filled", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    await renderRules();
    fireEvent.click(button("Add Rule"));
    const sheet = screen.getByRole("dialog", { name: "Add Rule" });
    const add = within(sheet).getByRole("button", { name: "Add" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(sheetInput("Receipt keyword").placeholder).toBe("e.g. acme");
    expect(sheetInput("Transaction keyword").placeholder).toBe("e.g. acme corp");

    fireEvent.change(sheetInput("Receipt keyword"), { target: { value: " initech " } });
    expect(add.disabled).toBe(true);
    expect(within(sheet).getByText("Fill in both keywords of every rule.")).toBeTruthy();

    fireEvent.change(sheetInput("Transaction keyword"), { target: { value: "initech llc " } });
    expect(add.disabled).toBe(false);
    expect(within(sheet).queryByText("Fill in both keywords of every rule.")).toBeNull();

    fireEvent.click(add);
    expect(saveRules).toHaveBeenCalledWith([
      ...rules,
      { id: "00000000-0000-4000-8000-000000000001", receiptVendor: "initech", transactionDescription: "initech llc" },
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(rows()).toHaveLength(3);
    expect(rows()[2].textContent).toBe("initechinitech llc");
  });

  it("does not warn about an empty new rule", async () => {
    await renderRules();
    fireEvent.click(button("Add Rule"));
    fireEvent.change(sheetInput("Receipt keyword"), { target: { value: "   " } });
    expect(screen.queryByText("Fill in both keywords of every rule.")).toBeNull();
  });

  it("cancels adding a rule", async () => {
    await renderRules();
    fireEvent.click(button("Add Rule"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saveRules).not.toHaveBeenCalled();
  });

  it("edits a rule on double-click", async () => {
    await renderRules();
    fireEvent.doubleClick(rows()[1]);
    const sheet = screen.getByRole("dialog", { name: "Edit Rule" });
    expect(sheetInput("Receipt keyword").value).toBe("globex");
    expect(sheetInput("Transaction keyword").value).toBe("globex ltd");
    fireEvent.change(sheetInput("Transaction keyword"), { target: { value: "globex corporation" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(saveRules).toHaveBeenCalledWith([rules[0], { id: "rule-2", receiptVendor: "globex", transactionDescription: "globex corporation" }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(rows()[1].textContent).toBe("globexglobex corporation");
  });

  it("edits a rule on Enter", async () => {
    await renderRules();
    fireEvent.keyDown(rows()[0], { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Edit Rule" })).toBeTruthy();
    expect(sheetInput("Receipt keyword").value).toBe("acme");
  });

  it("gives an edited rule without an id a new one", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000002");
    await renderRules([makeRule({ id: "" })]);
    fireEvent.doubleClick(rows()[0]);
    fireEvent.submit(screen.getByRole("dialog"));
    expect(saveRules).toHaveBeenCalledWith([{ ...makeRule(), id: "00000000-0000-4000-8000-000000000002" }]);
  });

  it("selects a row on click and deletes it with the minus button", async () => {
    await renderRules();
    expect(button("Delete Rule").disabled).toBe(true);
    fireEvent.click(rows()[0]);
    expect(rows()[0].getAttribute("aria-selected")).toBe("true");
    expect(rows()[1].getAttribute("aria-selected")).toBe("false");
    fireEvent.click(button("Delete Rule"));
    expect(saveRules).toHaveBeenCalledWith([rules[1]]);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(button("Delete Rule").disabled).toBe(true);
  });

  it.each(["Backspace", "Delete"])("deletes a focused row with %s", async (key) => {
    await renderRules();
    rows()[1].focus();
    fireEvent.keyDown(rows()[1], { key });
    expect(saveRules).toHaveBeenCalledWith([rules[0]]);
    await waitFor(() => expect(rows()).toHaveLength(1));
  });

  it("ignores other keys on a row", async () => {
    await renderRules();
    fireEvent.keyDown(rows()[0], { key: "a" });
    expect(saveRules).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables the buttons while saving", async () => {
    const saving = deferred<typeof rules>();
    vi.mocked(saveRules).mockReturnValue(saving.promise);
    await renderRules();
    fireEvent.click(rows()[0]);
    fireEvent.click(button("Delete Rule"));
    expect(button("Add Rule").disabled).toBe(true);
    expect(button("Delete Rule").disabled).toBe(true);
    await act(async () => saving.resolve([rules[1]]));
    expect(button("Add Rule").disabled).toBe(false);
  });

  it("shows a failed save in the window's error banner", async () => {
    vi.mocked(saveRules).mockRejectedValue({ kind: "io", message: "match-rules.json is locked" });
    await renderRules();
    fireEvent.keyDown(rows()[0], { key: "Backspace" });
    expect((await screen.findByRole("alert")).textContent).toBe("Concilia couldn't read or write a file: match-rules.json is locked");
    expect(rows()).toHaveLength(2);
  });

  it("keeps the sheet open when saving a rule fails", async () => {
    vi.mocked(saveRules).mockRejectedValue({ kind: "io", message: "match-rules.json is locked" });
    await renderRules();
    fireEvent.click(button("Add Rule"));
    fireEvent.change(sheetInput("Receipt keyword"), { target: { value: "initech" } });
    fireEvent.change(sheetInput("Transaction keyword"), { target: { value: "initech llc" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(sheetInput("Receipt keyword").value).toBe("initech");
  });

  it("reports a failure to load the rules", async () => {
    vi.mocked(getRules).mockRejectedValue({ kind: "parse", message: "match-rules.json" });
    await renderSettings(makeView(), "rules");
    expect((await screen.findByRole("alert")).textContent).toBe("Concilia couldn't read the statement: match-rules.json");
    expect(screen.queryByRole("table")).toBeNull();
  });
});
