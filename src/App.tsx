// Loaded first so component stylesheets, imported after it, win ties on specificity.
import "./App.css";
import { lazy, Suspense } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { viewFromSearch } from "./lib/view";

const Main = lazy(() => import("./main/Main").then((m) => ({ default: m.Main })));
const Settings = lazy(() => import("./settings/Settings").then((m) => ({ default: m.Settings })));

function App() {
  const view = viewFromSearch(window.location.search);
  switch (view) {
    case "settings":
      return (
        <ErrorBoundary>
          <Suspense fallback={null}>
            <Settings />
          </Suspense>
        </ErrorBoundary>
      );
    case "main":
    default:
      return (
        <ErrorBoundary>
          <Suspense fallback={null}>
            <Main />
          </Suspense>
        </ErrorBoundary>
      );
  }
}

export default App;
