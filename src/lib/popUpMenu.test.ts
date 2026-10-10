// @vitest-environment jsdom
import { isTauri } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeMenus, isTextField, popUpMenu, type MenuEntry } from "./popUpMenu";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  isTauri: vi.fn(() => false),
}));

vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: vi.fn() } }));

afterEach(() => {
  closeMenus();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function anchor(): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = "More";
  document.body.append(button);
  button.focus();
  return button;
}

function items(): string[] {
  return Array.from(document.querySelectorAll("[role=menu]:last-of-type [role=menuitem]")).map(
    (item) => `${(item as HTMLButtonElement).disabled ? "-" : ""}${item.textContent}`,
  );
}

function key(name: string) {
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
}

const refund = vi.fn();
const open = vi.fn();
const ENTRIES: MenuEntry[] = [
  { label: "Assign Receipt", onSelect: vi.fn(), disabled: true },
  {
    label: "No Receipt Needed",
    submenu: [
      { label: "Bank Fee", onSelect: vi.fn() },
      { label: "Refund", onSelect: refund },
    ],
  },
  "separator",
  { label: "Open in Preview", onSelect: open },
];

describe("popUpMenu in the browser", () => {
  it("lists the items, with separators and unavailable items disabled, focusing the first available one", async () => {
    await popUpMenu(ENTRIES, anchor());
    expect(items()).toEqual(["-Assign Receipt", "No Receipt Needed", "Open in Preview"]);
    expect(document.querySelectorAll("[role=separator]")).toHaveLength(1);
    expect(document.activeElement?.textContent).toBe("No Receipt Needed");
  });

  it("runs a picked item, closes and returns focus to the button", async () => {
    const button = anchor();
    await popUpMenu(ENTRIES, button);
    (document.querySelector("[role=menuitem]:last-of-type") as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("moves with the arrow keys, opens a submenu with → and picks with a click", async () => {
    await popUpMenu(ENTRIES, anchor());
    key("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Open in Preview");
    key("ArrowDown");
    expect(document.activeElement?.textContent).toBe("No Receipt Needed");
    key("ArrowRight");
    expect(document.querySelectorAll("[role=menu]")).toHaveLength(2);
    expect(document.activeElement?.textContent).toBe("Bank Fee");
    key("ArrowLeft");
    expect(document.querySelectorAll("[role=menu]")).toHaveLength(1);
    expect(document.activeElement?.textContent).toBe("No Receipt Needed");
    key("ArrowRight");
    key("End");
    (document.activeElement as HTMLButtonElement).click();
    expect(refund).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[role=menu]")).toBeNull();
  });

  it("closes on Escape without running anything", async () => {
    const button = anchor();
    await popUpMenu(ENTRIES, button);
    key("Escape");
    expect(document.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(open).not.toHaveBeenCalled();
  });

  it("closes on a click outside it", async () => {
    vi.useFakeTimers();
    await popUpMenu(ENTRIES, { x: 10, y: 20 });
    vi.advanceTimersByTime(0);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector("[role=menu]")).toBeNull();
    vi.useRealTimers();
  });

  it("replaces a menu that is already open", async () => {
    await popUpMenu(ENTRIES, anchor());
    await popUpMenu([{ label: "Remove", onSelect: vi.fn() }], { x: 0, y: 0 });
    expect(document.querySelectorAll("[role=menu]")).toHaveLength(1);
    expect(items()).toEqual(["Remove"]);
  });
});

describe("popUpMenu in the app", () => {
  it("builds a native menu and pops it up under the button", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const popup = vi.fn().mockResolvedValue(undefined);
    vi.mocked(Menu.new).mockResolvedValue({ popup, close: vi.fn().mockResolvedValue(undefined) } as unknown as Menu);
    const button = anchor();
    button.getBoundingClientRect = () => ({ left: 30, bottom: 50 }) as DOMRect;
    await popUpMenu(ENTRIES, button);
    const options = vi.mocked(Menu.new).mock.calls[0][0]!;
    expect(options.items).toEqual([
      { text: "Assign Receipt", enabled: false, action: expect.any(Function) },
      {
        text: "No Receipt Needed",
        enabled: true,
        items: [
          { text: "Bank Fee", enabled: true, action: expect.any(Function) },
          { text: "Refund", enabled: true, action: expect.any(Function) },
        ],
      },
      { item: "Separator" },
      { text: "Open in Preview", enabled: true, action: expect.any(Function) },
    ]);
    (options.items![3] as { action: (id: string) => void }).action("");
    expect(open).toHaveBeenCalledTimes(1);
    expect(popup.mock.calls[0][0]).toMatchObject({ x: 30, y: 54 });
    expect(document.querySelector("[role=menu]")).toBeNull();
  });

  it("releases the previous native menu when the next one opens", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const first = { popup: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    const second = { popup: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(Menu.new)
      .mockResolvedValueOnce(first as unknown as Menu)
      .mockResolvedValueOnce(second as unknown as Menu);
    await popUpMenu(ENTRIES, { x: 0, y: 0 });
    await popUpMenu(ENTRIES, { x: 0, y: 0 });
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
  });
});

describe("isTextField", () => {
  it("is true for fields that edit text", () => {
    const text = document.createElement("input");
    const box = document.createElement("input");
    box.type = "checkbox";
    expect([isTextField(text), isTextField(document.createElement("textarea")), isTextField(box), isTextField(document.body), isTextField(null)]).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});
