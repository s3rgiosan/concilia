// Context and pull-down menus. Inside the app they are native menus; the browser preview and the
// tests get an HTML menu with the same items and keyboard handling.

import { isTauri } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu, type MenuItemOptions, type PredefinedMenuItemOptions, type SubmenuOptions } from "@tauri-apps/api/menu";

export type MenuEntry =
  | { label: string; onSelect: () => void; disabled?: boolean }
  | { label: string; submenu: MenuEntry[]; disabled?: boolean }
  | "separator";

/** Where a menu opens: under an element (a button), or at a point in the window (a right click). */
export type MenuAnchor = HTMLElement | { x: number; y: number };

/** Space between a button and the menu that drops from it. */
const GAP = 4;

function anchorPoint(anchor: MenuAnchor): { x: number; y: number } {
  if (anchor instanceof HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    return { x: rect.left, y: rect.bottom + GAP };
  }
  return anchor;
}

// Native ------------------------------------------------------------------------------------------

type NativeItem = MenuItemOptions | SubmenuOptions | PredefinedMenuItemOptions;

function nativeItems(entries: MenuEntry[]): NativeItem[] {
  return entries.map((entry): NativeItem => {
    if (entry === "separator") {
      return { item: "Separator" };
    }
    if ("submenu" in entry) {
      return { text: entry.label, enabled: !entry.disabled, items: nativeItems(entry.submenu) };
    }
    return { text: entry.label, enabled: !entry.disabled, action: () => entry.onSelect() };
  });
}

/** The menu shown last. It stays alive while it shows, so its items can still run, and is released when the next one opens. */
let shown: Menu | null = null;

async function popUpNative(entries: MenuEntry[], anchor: MenuAnchor): Promise<void> {
  const { x, y } = anchorPoint(anchor);
  const menu = await Menu.new({ items: nativeItems(entries) });
  const previous = shown;
  shown = menu;
  previous?.close().catch(() => undefined);
  await menu.popup(new LogicalPosition(x, y));
}

// HTML --------------------------------------------------------------------------------------------

/** Open HTML menus, the outermost first. */
const open: HTMLElement[] = [];
let returnFocus: HTMLElement | null = null;
let stopListening: (() => void) | null = null;

function enabledItems(menu: HTMLElement): HTMLButtonElement[] {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>(":scope > [role=menuitem]:not(:disabled)"));
}

function closeFrom(depth: number) {
  for (const menu of open.splice(depth)) {
    menu.remove();
  }
  for (const item of open[depth - 1]?.querySelectorAll("[aria-expanded=true]") ?? []) {
    item.setAttribute("aria-expanded", "false");
  }
}

/** Closes every open HTML menu and returns focus to where it was before the menu opened. */
export function closeMenus(): void {
  if (open.length === 0) {
    return;
  }
  closeFrom(0);
  stopListening?.();
  stopListening = null;
  const target = returnFocus;
  returnFocus = null;
  if (target?.isConnected) {
    target.focus();
  }
}

function place(menu: HTMLElement, x: number, y: number) {
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - GAP) {
    menu.style.left = `${Math.max(GAP, window.innerWidth - GAP - rect.width)}px`;
  }
  if (rect.bottom > window.innerHeight - GAP) {
    menu.style.top = `${Math.max(GAP, window.innerHeight - GAP - rect.height)}px`;
  }
}

function buildMenu(entries: MenuEntry[], depth: number, x: number, y: number, label?: string): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "html-menu";
  menu.setAttribute("role", "menu");
  if (label) {
    menu.setAttribute("aria-label", label);
  }
  for (const entry of entries) {
    if (entry === "separator") {
      const line = document.createElement("div");
      line.className = "html-menu__separator";
      line.setAttribute("role", "separator");
      menu.append(line);
      continue;
    }
    const item = document.createElement("button");
    item.type = "button";
    item.className = "html-menu__item";
    item.setAttribute("role", "menuitem");
    item.textContent = entry.label;
    item.disabled = Boolean(entry.disabled);
    if ("submenu" in entry) {
      const submenu = entry.submenu;
      item.setAttribute("aria-haspopup", "menu");
      item.setAttribute("aria-expanded", "false");
      const openSubmenu = () => {
        if (open[depth + 1]?.dataset.parent === entry.label) {
          return;
        }
        closeFrom(depth + 1);
        const rect = item.getBoundingClientRect();
        const child = buildMenu(submenu, depth + 1, rect.right, rect.top - 5, entry.label);
        child.dataset.parent = entry.label;
        item.setAttribute("aria-expanded", "true");
        enabledItems(child)[0]?.focus();
      };
      item.addEventListener("click", openSubmenu);
      item.addEventListener("mouseenter", openSubmenu);
    } else {
      const run = entry.onSelect;
      item.addEventListener("click", () => {
        closeMenus();
        run();
      });
      item.addEventListener("mouseenter", () => {
        closeFrom(depth + 1);
        item.focus();
      });
    }
    menu.append(item);
  }
  menu.addEventListener("keydown", (e) => onMenuKey(e, menu, depth));
  document.body.append(menu);
  open[depth] = menu;
  place(menu, x, y);
  return menu;
}

function onMenuKey(e: KeyboardEvent, menu: HTMLElement, depth: number) {
  const items = enabledItems(menu);
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  switch (e.key) {
    case "ArrowDown":
      items[(index + 1) % items.length]?.focus();
      break;
    case "ArrowUp":
      items[(index - 1 + items.length) % items.length]?.focus();
      break;
    case "Home":
      items[0]?.focus();
      break;
    case "End":
      items[items.length - 1]?.focus();
      break;
    case "ArrowRight":
      if (items[index]?.getAttribute("aria-haspopup") === "menu") {
        items[index].click();
      }
      break;
    case "ArrowLeft":
    case "Escape":
      if (depth > 0) {
        const owner = open[depth - 1]?.querySelector<HTMLElement>("[aria-expanded=true]");
        closeFrom(depth);
        owner?.focus();
      } else if (e.key === "Escape") {
        closeMenus();
      } else {
        return;
      }
      break;
    case "Tab":
      closeMenus();
      break;
    default:
      return;
  }
  e.preventDefault();
  e.stopPropagation();
}

function popUpHtml(entries: MenuEntry[], anchor: MenuAnchor): void {
  closeMenus();
  returnFocus = anchor instanceof HTMLElement ? anchor : document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const { x, y } = anchorPoint(anchor);
  const menu = buildMenu(entries, 0, x, y);
  enabledItems(menu)[0]?.focus();
  const onPointer = (e: Event) => {
    if (!open.some((m) => m.contains(e.target as Node))) {
      closeMenus();
    }
  };
  const onBlur = () => closeMenus();
  // Added after this event finishes, so the click that opened the menu does not close it.
  const timer = window.setTimeout(() => {
    document.addEventListener("mousedown", onPointer, true);
    document.addEventListener("contextmenu", onPointer, true);
  }, 0);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", onBlur);
  stopListening = () => {
    window.clearTimeout(timer);
    document.removeEventListener("mousedown", onPointer, true);
    document.removeEventListener("contextmenu", onPointer, true);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("resize", onBlur);
  };
}

/**
 * Shows `entries` as a menu under a button or at a point. Each item runs its `onSelect` when
 * picked. Resolves once the menu shows.
 */
export function popUpMenu(entries: MenuEntry[], anchor: MenuAnchor): Promise<void> {
  if (isTauri()) {
    return popUpNative(entries, anchor).catch((e) => console.error("could not show the menu", e));
  }
  popUpHtml(entries, anchor);
  return Promise.resolve();
}

/** Whether `target` is a field that edits text, where the web view's own context menu stays. */
export function isTextField(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) {
    return true;
  }
  if (target instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "submit", "reset", "file", "range", "color", "image"].includes(target.type);
  }
  return target instanceof HTMLElement && target.isContentEditable === true;
}
