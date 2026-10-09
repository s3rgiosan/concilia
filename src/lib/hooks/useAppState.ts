import { useCallback, useEffect, useState } from "react";
import { applyLanguage } from "../../i18n";
import { getAppState, onBusyChanged, onSettingsChanged, subscribe, type AppStateView } from "../tauri";

/**
 * The app's setup, kept current by the backend's events. The UI language follows the saved
 * choice. `replace` takes a view returned by a command, before its event arrives.
 */
export function useAppState(): {
  state: AppStateView | null;
  error: unknown;
  replace: (view: AppStateView) => void;
  reload: () => void;
} {
  const [state, setState] = useState<AppStateView | null>(null);
  const [error, setError] = useState<unknown>(null);

  const replace = useCallback((view: AppStateView) => {
    setState(view);
    applyLanguage(view.settings.language).catch((e) => console.error("could not change language", e));
  }, []);

  const reload = useCallback(() => {
    getAppState().then(
      (view) => {
        setError(null);
        replace(view);
      },
      (e) => setError(e),
    );
  }, [replace]);

  useEffect(() => {
    reload();
    const stopSettings = subscribe(onSettingsChanged(replace));
    const stopBusy = subscribe(onBusyChanged((busy) => setState((prev) => (prev ? { ...prev, busy } : prev))));
    return () => {
      stopSettings();
      stopBusy();
    };
  }, [reload, replace]);

  return { state, error, replace, reload };
}
