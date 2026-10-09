import type { AppStateView, Settings } from "../lib/tauri";

/** What every Settings pane receives. */
export interface PaneProps {
  state: AppStateView;
  /** Saves the settings returned by `change`, applied to the current ones. */
  save: (change: (settings: Settings) => Settings) => void;
  onError: (e: unknown) => void;
}
