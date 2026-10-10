import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useLatest } from "../lib/hooks/useLatest";
import { Icon } from "./Icon";

const FIT_STYLE = { width: "max-content", minWidth: 440, maxWidth: "calc(100vw - 48px)" };

const FOCUSABLE = 'input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Marks every element outside `keep` as inert, so pointer, focus and assistive technology stay in
 * the sheet. Returns a function that restores the elements it changed.
 */
function makeOthersInert(keep: HTMLElement): () => void {
  const changed: Element[] = [];
  let node = keep;
  while (node.parentElement && node !== document.body) {
    const parent: HTMLElement = node.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling !== node && !sibling.hasAttribute("inert")) {
        sibling.setAttribute("inert", "");
        changed.push(sibling);
      }
    }
    node = parent;
  }
  return () => {
    for (const el of changed) {
      el.removeAttribute("inert");
    }
  };
}

/**
 * Window-modal behaviour shared by sheets and Quick Look: while `panel` shows, everything outside
 * `backdrop` is inert, focus starts on `initialFocus` (or the panel) and Tab cycles within the
 * panel. Esc runs `onEscape` unless busy. Focus returns to where it was when the panel closes.
 */
export function useModal(
  backdrop: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  onEscape: () => void,
  { busy = false, initialFocus }: { busy?: boolean; initialFocus?: string } = {},
) {
  const latest = useLatest({ onEscape, busy, initialFocus });

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreOthers = backdrop.current ? makeOthersInert(backdrop.current) : () => undefined;
    const selector = latest.current.initialFocus;
    const first = selector ? panel.current?.querySelector<HTMLElement>(selector) : null;
    (first ?? panel.current)?.focus();
    return () => {
      restoreOthers();
      if (previous?.isConnected) {
        previous.focus();
      }
    };
  }, [backdrop, panel, latest]);

  useEffect(() => {
    function focusable(): HTMLElement[] {
      const found = panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [];
      return Array.from(found).filter((el) => !el.hasAttribute("disabled"));
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!latest.current.busy) {
          latest.current.onEscape();
        }
        return;
      }
      if (e.key !== "Tab") {
        return;
      }
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && panel.current?.contains(active);
      if (!inside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, latest]);
}

/** A note under a sheet's fields: label-coloured text after a red (error) or orange (warning) symbol. */
export function SheetNote({ tone = "error", children }: { tone?: "error" | "warning"; children: ReactNode }) {
  return (
    <p className={`sheet__note sheet__note--${tone}`} role={tone === "error" ? "alert" : undefined}>
      <Icon name="warning" size={13} className="sheet__note-icon" />
      <span>{children}</span>
    </p>
  );
}

/**
 * A window-modal sheet that slides down from the top of the window, like macOS sheets. Esc
 * cancels (unless busy), Return activates the default button, and Tab cycles within the sheet.
 * The rest of the window is inert while it shows, and focus returns to where it was when it
 * closes. On a destructive sheet Cancel is the default button and takes initial focus, so Return
 * never confirms the destructive action; the sheet is an alert dialog described by `message`.
 */
export function Sheet({
  title,
  message,
  children,
  onCancel,
  onSubmit,
  submitLabel,
  submitDisabled,
  destructive,
  busy,
  busyLabel,
  width = 440,
  accessory,
}: {
  title: string;
  /** Explanatory text shown first in the body and announced as the sheet's description. */
  message?: ReactNode;
  children?: ReactNode;
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
  submitDisabled?: boolean;
  destructive?: boolean;
  busy?: boolean;
  /** Submit button text while busy; "Working…" when not given. */
  busyLabel?: string;
  /**
   * A width in pixels, or "fit" to size the sheet to its content: at least 440 px and at most the
   * window width less 48 px.
   */
  width?: number | "fit";
  /** Secondary control shown at the leading end of the action row, such as a test button. */
  accessory?: ReactNode;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLFormElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const messageId = useId();
  useModal(backdrop, ref, onCancel, { busy, initialFocus: "input, select, textarea, button.default" });

  function confirm() {
    if (!submitDisabled && !busy) {
      onSubmit();
    }
  }

  return (
    <div className="sheet-backdrop" ref={backdrop}>
      <form
        ref={ref}
        className="sheet"
        style={width === "fit" ? FIT_STYLE : { width }}
        role={destructive ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-label={title}
        aria-describedby={message ? messageId : undefined}
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
        onKeyDown={(e) => {
          const target = e.target;
          const onButton = target instanceof HTMLElement && target.tagName === "BUTTON";
          if (destructive && e.key === "Enter" && !onButton) {
            e.preventDefault();
            if (!busy) {
              onCancel();
            }
          }
        }}
      >
        <h2 className="sheet__title">{title}</h2>
        <div className="sheet__body">
          {message ? (
            <p className="sheet__text" id={messageId}>
              {message}
            </p>
          ) : null}
          {children}
        </div>
        <div className="sheet__actions">
          {accessory ? <div className="sheet__accessory">{accessory}</div> : null}
          <button type="button" className={destructive ? "default" : undefined} onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button
            type={destructive ? "button" : "submit"}
            className={destructive ? "destructive" : "default"}
            onClick={destructive ? confirm : undefined}
            disabled={submitDisabled || busy}
          >
            {busy ? (busyLabel ?? t("common.working")) : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
