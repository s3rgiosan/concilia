// The shared styles load before the feature stylesheets, which refine them.
import "./styles/tokens.css";
import "./App.css";
import "./styles/controls.css";
import "./components/Banner.css";
import "./components/PopUpButton.css";
import "./components/Sheet.css";
import "./components/Toolbar.css";
import { lazy, Suspense } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import type { AppStateView } from "./lib/tauri";
import { isTextField } from "./lib/popUpMenu";
import { viewFromSearch } from "./lib/view";

const Main = lazy(() => import("./main/Main").then((m) => ({ default: m.Main })));
const Settings = lazy(() => import("./settings/Settings").then((m) => ({ default: m.Settings })));

// The web view's own context menu (Reload, Inspect Element) stays out of the app; text fields keep
// theirs for Cut, Copy and Paste. Elements with their own menu show it from their handler first.
// Holding Option keeps it in development builds, for the web inspector.
document.addEventListener("contextmenu", (e) => {
  if (!isTextField(e.target) && !(import.meta.env.DEV && e.altKey)) {
    e.preventDefault();
  }
});

/** The window for the `view` in the address. `initialState` is the setup read at launch, so the window need not read it again. */
function App({ initialState = null }: { initialState?: AppStateView | null }) {
  const view = viewFromSearch(window.location.search);
  switch (view) {
    case "settings":
      return (
        <ErrorBoundary>
          <Suspense fallback={null}>
            <Settings initialState={initialState} />
          </Suspense>
        </ErrorBoundary>
      );
    case "main":
    default:
      return (
        <ErrorBoundary>
          <Suspense fallback={null}>
            <Main initialState={initialState} />
          </Suspense>
        </ErrorBoundary>
      );
  }
}

export default App;
