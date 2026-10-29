import React from "react";
import ReactDOM from "react-dom/client";
import { viewFromSearch } from "./lib/view";

async function start() {
  // A plain browser during `npm run dev` gets a fake backend for design previews.
  const inTauri = "__TAURI_INTERNALS__" in window;
  if (import.meta.env.DEV && !inTauri) {
    const { install } = await import("./dev/mock");
    install();
  }
  const view = viewFromSearch(window.location.search);
  // The window's own screen loads while the setup and the language are read.
  const app = import("./App");
  switch (view) {
    case "settings":
      void import("./settings/Settings");
      break;
    case "main":
    default:
      void import("./main/Main");
      break;
  }
  // The saved language applies before the first render, so the window never flashes English.
  const [{ IS_MACOS }, { installAppearance }, { applyLanguage }, state] = await Promise.all([
    import("./lib/platform"),
    import("./lib/appearance"),
    import("./i18n"),
    import("./lib/tauri").then(({ getAppState }) =>
      getAppState().catch((e) => {
        console.error("could not load the language setting", e);
        return null;
      }),
    ),
  ]);
  // The main window on macOS is transparent over the sidebar material; `vibrant` lets the sidebar
  // show it and paints every other area solid. The browser preview keeps a solid window.
  if (inTauri && IS_MACOS && view === "main") {
    document.documentElement.classList.add("vibrant");
  }
  installAppearance();
  await applyLanguage(state?.settings.language ?? null);
  const { default: App } = await app;

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App initialState={state} />
    </React.StrictMode>,
  );
}

start();
