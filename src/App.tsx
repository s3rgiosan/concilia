// Loaded first so component stylesheets, imported after it, win ties on specificity.
import "./App.css";
import { lazy, Suspense } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";

const Main = lazy(() => import("./main/Main").then((m) => ({ default: m.Main })));
// Checks for the webview and the bundled tools; only on the dev server.
const Spike = import.meta.env.DEV ? lazy(() => import("./dev/Spike").then((m) => ({ default: m.Spike }))) : null;

function App() {
  if (Spike && new URLSearchParams(window.location.search).get("view") === "spike") {
    return (
      <Suspense fallback={null}>
        <Spike />
      </Suspense>
    );
  }

  return (
    <ErrorBoundary>
      <Suspense fallback={null}>
        <Main />
      </Suspense>
    </ErrorBoundary>
  );
}

export default App;
