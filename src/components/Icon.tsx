// Symbols are drawn as a CSS mask so they take the text color: SF Symbols on macOS, Lucide
// elsewhere, both exported by scripts/symbols.mjs.
import "../assets/symbols/symbols.css";

/** Every symbol export, each drawn by the `.symbol--<name>` class in symbols.css. */
export const SYMBOL_NAMES = [
  "refresh",
  "gear",
  "search",
  "disclosure",
  "folder",
  "plus",
  "minus",
  "check",
  "warning",
  "external",
  "xmark",
  "doc",
  "eye",
  "save",
  "key",
  "rules",
  "drop",
  "globe",
  "sparkles",
  "sidebar",
  "inspector",
] as const;

export type IconName = (typeof SYMBOL_NAMES)[number];

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  const classes = className ? `symbol symbol--${name} ${className}` : `symbol symbol--${name}`;
  return <span className={classes} aria-hidden="true" style={{ width: size, height: size }} />;
}
