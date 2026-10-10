import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { IS_MACOS } from "../lib/platform";

/**
 * The window's 52 px toolbar, drawn under the transparent macOS title bar. On macOS the leading
 * area starts after the traffic lights. Every empty part drags the window, and a double click
 * zooms it. `leadingWidth` sizes the leading area to the sidebar below it, so the title lines up
 * with the detail pane. Without `separator` the toolbar blends into the content below.
 */
export function Toolbar({
  leading,
  leadingWidth,
  title,
  subtitle,
  trailing,
  separator = true,
}: {
  leading?: ReactNode;
  leadingWidth?: number;
  title?: string;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  separator?: boolean;
}) {
  const leadingClass = leadingWidth ? "titlebar__leading titlebar__leading--sidebar" : "titlebar__leading";
  const classes = ["titlebar", IS_MACOS ? "titlebar--inset" : null, separator ? null : "titlebar--plain"].filter(Boolean).join(" ");
  return (
    <header className={classes} data-tauri-drag-region>
      <div className={leadingClass} style={leadingWidth ? { width: leadingWidth } : undefined} data-tauri-drag-region>
        {leading}
      </div>
      <div className="titlebar__heading" data-tauri-drag-region>
        {title ? (
          <h1 className="titlebar__title" data-tauri-drag-region>
            {title}
          </h1>
        ) : null}
        {subtitle ? (
          <p className="titlebar__subtitle" data-tauri-drag-region>
            {subtitle}
          </p>
        ) : null}
      </div>
      {trailing ? (
        <div className="titlebar__trailing" data-tauri-drag-region>
          {trailing}
        </div>
      ) : null}
    </header>
  );
}

/** Elements in the toolbar that a pane fills with its own subtitle and trailing controls. */
export interface ToolbarSlots {
  subtitle: HTMLElement | null;
  trailing: HTMLElement | null;
}

/** Renders `children` into a toolbar slot once the slot exists. */
export function ToolbarPortal({ target, children }: { target: HTMLElement | null; children: ReactNode }) {
  return target ? createPortal(children, target) : null;
}
