import React from "react";
import ReactDOM from "react-dom/client";

async function start() {
  // A plain browser during `npm run dev` gets a fake backend for design previews.
  const inTauri = "__TAURI_INTERNALS__" in window;
  if (import.meta.env.DEV && !inTauri) {
    const { install } = await import("./dev/mock");
    install();
  }
  // The main window on macOS is transparent over the sidebar material; `vibrant` lets the sidebar
  // show it and paints every other area solid. The browser preview keeps a solid window.
  const { IS_MACOS } = await import("./lib/platform");
  const { viewFromSearch } = await import("./lib/view");
  const view = viewFromSearch(window.location.search);
  if (inTauri && IS_MACOS && view === "main") {
    document.documentElement.classList.add("vibrant");
  }
  // The saved language applies before the first render, so the window never flashes English.
  const { applyLanguage } = await import("./i18n");
  const { getAppState } = await import("./lib/tauri");
  await getAppState()
    .then((state) => applyLanguage(state.settings.language))
    .catch((e) => console.error("could not load the language setting", e));
  const { default: App } = await import("./App");

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

start();
