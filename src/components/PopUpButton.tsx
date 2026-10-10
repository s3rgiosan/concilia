import { useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { popUpMenu, type MenuEntry } from "../lib/popUpMenu";
import { useFormDescription } from "./Form";

function Chevron() {
  return (
    <svg className="popup-button__chevron" width="8" height="12" viewBox="0 0 8 12" aria-hidden="true">
      <path d="M1.2 4.3 4 1.5l2.8 2.8M1.2 7.7 4 10.5l2.8-2.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A macOS pop-up button: a filled button showing the current choice and a ⌃⌄ chevron. A
 * transparent native <select> covers it, so clicking opens WebKit's native menu with the system
 * look, keyboard handling and checkmark on the current item.
 */
export function PopUpButton<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
  id,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  id?: string;
  label: string;
}) {
  const describedBy = useFormDescription();
  const current = options.find((o) => o.value === value)?.label ?? "";
  return (
    <span className={`popup-button ${disabled ? "popup-button--disabled" : ""}`}>
      <span className="popup-button__label">{current}</span>
      <Chevron />
      <select
        id={id}
        aria-label={label}
        aria-describedby={describedBy}
        value={String(value)}
        disabled={disabled}
        onChange={(e) => {
          const picked = options.find((o) => String(o.value) === e.target.value);
          if (picked) {
            onChange(picked.value);
          }
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

export interface PopUpAction {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

function allDisabled(actions: MenuEntry[]): boolean {
  return actions.every((a) => a === "separator" || a.disabled);
}

/**
 * Handlers for a button that opens a menu, and whether its menu is open. A mouse press opens the
 * menu, so it shows before the button is released; the click that follows does nothing. Clicks
 * from the keyboard, a pen or touch open it on release.
 */
function useMenuButton(actions: MenuEntry[]) {
  const [open, setOpen] = useState(false);
  const pressed = useRef(false);

  function show(button: HTMLElement) {
    setOpen(true);
    void popUpMenu(actions, button, () => setOpen(false));
  }

  return {
    open,
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      pressed.current = e.button === 0 && e.pointerType === "mouse";
      if (pressed.current) {
        e.preventDefault();
        show(e.currentTarget);
      }
    },
    onClick: (e: MouseEvent<HTMLButtonElement>) => {
      const fromPress = pressed.current && e.detail > 0;
      pressed.current = false;
      if (!fromPress) {
        show(e.currentTarget);
      }
    },
  };
}

/**
 * An action pop-up button: a small `•••` button that opens a menu of commands under it on the
 * press, and stays highlighted while the menu shows. A borderless one shows its fill only on
 * hover, for use inside rows.
 */
export function ActionPopUpButton({
  actions,
  label = "More Actions",
  disabled,
  borderless,
  className,
}: {
  actions: MenuEntry[];
  label?: string;
  disabled?: boolean;
  borderless?: boolean;
  className?: string;
}) {
  const unavailable = disabled || allDisabled(actions);
  const menu = useMenuButton(actions);
  const classes = ["action-popup", borderless ? "action-popup--borderless" : null, className ?? null];
  return (
    <button
      type="button"
      className={classes.filter(Boolean).join(" ")}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={menu.open}
      title={label}
      disabled={unavailable}
      onPointerDown={menu.onPointerDown}
      onClick={menu.onClick}
    >
      <svg className="action-popup__glyph" width="13" height="3" viewBox="0 0 13 3" aria-hidden="true">
        <circle cx="1.5" cy="1.5" r="1.4" fill="currentColor" />
        <circle cx="6.5" cy="1.5" r="1.4" fill="currentColor" />
        <circle cx="11.5" cy="1.5" r="1.4" fill="currentColor" />
      </svg>
    </button>
  );
}

/**
 * A pull-down button: a labelled button with a ⌄ chevron that opens a menu of commands under it on
 * the press, and stays highlighted while the menu shows.
 */
export function PullDownButton({ label, actions, disabled }: { label: string; actions: MenuEntry[]; disabled?: boolean }) {
  const unavailable = disabled || allDisabled(actions);
  const menu = useMenuButton(actions);
  return (
    <button
      type="button"
      className="pull-down"
      aria-haspopup="menu"
      aria-expanded={menu.open}
      disabled={unavailable}
      onPointerDown={menu.onPointerDown}
      onClick={menu.onClick}
    >
      <span className="pull-down__label">{label}</span>
      <svg className="pull-down__chevron" width="9" height="6" viewBox="0 0 9 6" aria-hidden="true">
        <path d="M1 1.2 4.5 4.6 8 1.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
