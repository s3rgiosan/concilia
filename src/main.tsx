import React from "react";
import ReactDOM from "react-dom/client";

async function start() {
  // A plain browser during `npm run dev` gets a fake backend for design previews.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    const { install } = await import("./dev/mock");
    install();
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
