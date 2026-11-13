import { getAppearance, onAppearanceChanged, type Appearance } from "./tauri";

const REDUCED_TRANSPARENCY = "(prefers-reduced-transparency: reduce)";

/**
 * Applies the system settings the stylesheets follow through classes and tokens on the root:
 * `window-inactive` while the window is in the background, `reduce-transparency` while Reduce
 * Transparency is on, and the user's accent colour as `--accent`.
 */
export function installAppearance(): void {
  const root = document.documentElement;

  // A window starts active unless it loads hidden; focus and blur track it from then on.
  root.classList.toggle("window-inactive", document.visibilityState === "hidden");
  window.addEventListener("focus", () => root.classList.remove("window-inactive"));
  window.addEventListener("blur", () => root.classList.add("window-inactive"));
  document.addEventListener("visibilitychange", () => {
    const hidden = document.visibilityState === "hidden";
    if (hidden) {
      root.classList.add("window-inactive");
    } else if (document.hasFocus()) {
      root.classList.remove("window-inactive");
    }
  });

  // WKWebView never matches the media query, so the native setting is read too.
  const media = typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_TRANSPARENCY) : null;
  let nativeReduce = false;
  const syncTransparency = () => root.classList.toggle("reduce-transparency", nativeReduce || media?.matches === true);
  media?.addEventListener("change", syncTransparency);
  syncTransparency();

  const apply = (appearance: Appearance) => {
    nativeReduce = appearance.reduce_transparency;
    syncTransparency();
    if (appearance.accent) {
      root.style.setProperty("--accent", appearance.accent);
    } else {
      root.style.removeProperty("--accent");
    }
  };
  getAppearance().then(apply, (e) => console.error("could not read the appearance settings", e));
  onAppearanceChanged(apply).catch((e) => console.error("could not follow the appearance settings", e));
}
