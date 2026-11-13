import "./Settings.css";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ErrorText } from "../components/ErrorText";
import { Icon, type IconName } from "../components/Icon";
import { useAppState } from "../lib/hooks/useAppState";
import { useSafeStorage } from "../lib/hooks/useSafeStorage";
import { useWindowTitle } from "../lib/hooks/useWindowTitle";
import { isTextField } from "../lib/popUpMenu";
import { isPreview } from "../lib/preview";
import { onMenu, saveSettings, subscribe, type AppStateView, type Settings as SettingsData } from "../lib/tauri";
import { FolderTab } from "./FolderTab";
import { GeminiTab } from "./GeminiTab";
import { GeneralTab } from "./GeneralTab";
import { ReasonsTab } from "./ReasonsTab";
import { RulesTab } from "./RulesTab";
import { useFitWindow } from "./useFitWindow";

const PANES = ["folder", "gemini", "rules", "reasons", "general"] as const;
type Pane = (typeof PANES)[number];

const PANE_ICONS: Record<Pane, IconName> = {
  general: "gear",
  folder: "folder",
  gemini: "sparkles",
  rules: "rules",
  reasons: "reasons",
};

function isPane(value: string): value is Pane {
  return (PANES as readonly string[]).includes(value);
}

/** The Settings window: Folder, Gemini, Rules, Reasons and General panes. Every change saves at once. */
export function Settings({ initialState = null }: { initialState?: AppStateView | null }) {
  const { t } = useTranslation();
  const { state, error: loadError, replace, reload } = useAppState(initialState);
  const [stored, setStored] = useSafeStorage("settings.pane", "folder");
  const pane: Pane = isPane(stored) ? stored : "folder";
  /** The latest failure, boxed so any value can be held. */
  const [error, setError] = useState<{ cause: unknown } | null>(null);

  const paneTitle = loadError ? t("settings.title") : t(`settings.tabs.${pane}`);
  /** The pane on screen, and whether the user has moved to another one since the window opened. */
  const [shownPane, setShownPane] = useState(pane);
  const [switched, setSwitched] = useState(false);
  if (pane !== shownPane) {
    setShownPane(pane);
    setSwitched(true);
  }
  useWindowTitle(paneTitle);

  /** What Edit › Undo does outside a text field: set by the Rules pane while it can undo a removal. */
  const undoRule = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (isPreview()) {
      return;
    }
    return subscribe(
      onMenu((id) => {
        if (id !== "undo" && id !== "redo" && id !== "delete") {
          return;
        }
        if (isTextField(document.activeElement)) {
          document.execCommand(id);
        } else if (id === "undo") {
          undoRule.current?.();
        }
      }),
    );
  }, []);

  const bar = useRef<HTMLElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useFitWindow(bar, paneRef, content, state !== null);

  // Saves run one after another. Each change is applied to the last settings the backend
  // confirmed when its turn comes, so a failed change never reaches a later save.
  // The backend returns the stored settings, and the next change builds on them.
  const confirmed = useRef<SettingsData | null>(null);
  const pending = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (state && pending.current === 0) {
      confirmed.current = state.settings;
    }
  }, [state]);

  const save = useCallback(
    (change: (settings: SettingsData) => SettingsData) => {
      const start = confirmed.current ?? state?.settings;
      if (!start) {
        return;
      }
      pending.current += 1;
      setError(null);
      const run = () => {
        const next = change(confirmed.current ?? start);
        return saveSettings(next)
          .then(
            (view) => {
              confirmed.current = view.settings;
              replace(view);
            },
            (e) => {
              setError({ cause: e });
              reload();
            },
          )
          .finally(() => {
            pending.current -= 1;
          });
      };
      queue.current = pending.current === 1 ? run() : queue.current.then(run);
    },
    [state, replace, reload],
  );

  const report = useCallback((e: unknown) => setError({ cause: e }), []);

  /** Moves between the pane switcher's tabs with ← and →, wrapping at the ends. */
  function onTabKeyDown(e: KeyboardEvent<HTMLElement>) {
    let step: number;
    switch (e.key) {
      case "ArrowRight":
        step = 1;
        break;
      case "ArrowLeft":
        step = -1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const next = PANES[(PANES.indexOf(pane) + step + PANES.length) % PANES.length];
    setError(null);
    setStored(next);
    document.getElementById(`settings-tab-${next}`)?.focus();
  }

  if (loadError) {
    return (
      <div className="settings">
        <div className="pane">
          <div className="banner banner--error" role="alert">
            <Icon name="warning" size={14} />
            <span className="grow">
              <ErrorText error={loadError} />
            </span>
            <button type="button" className="banner__action" onClick={reload}>
              {t("common.tryAgain")}
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (!state) {
    return null;
  }

  return (
    <div className="settings">
      <header className="settings__bar" ref={bar} data-tauri-drag-region>
        <div className="settings__tabs" role="tablist" aria-label={t("settings.title")} onKeyDown={onTabKeyDown}>
          {PANES.map((id) => (
            <button
              key={id}
              id={`settings-tab-${id}`}
              type="button"
              role="tab"
              className={`toolbar__tab ${id === pane ? "toolbar__tab--active" : ""}`}
              aria-selected={id === pane}
              aria-controls="settings-pane"
              tabIndex={id === pane ? 0 : -1}
              onClick={() => {
                setError(null);
                setStored(id);
              }}
            >
              <Icon name={PANE_ICONS[id]} size={20} />
              {t(`settings.tabs.${id}`)}
            </button>
          ))}
        </div>
      </header>
      <main className="pane" id="settings-pane" role="tabpanel" aria-labelledby={`settings-tab-${pane}`} ref={paneRef}>
        <div className="pane__content" ref={content}>
          {state.read_only ? (
            <div className="banner banner--warn" role="status">
              <Icon name="warning" size={14} />
              <span>{t("settings.readOnly")}</span>
            </div>
          ) : null}
          {state.unreadable_files.length > 0 ? (
            <div className="banner banner--error" role="alert">
              <Icon name="warning" size={14} />
              <span>
                {t("settings.unreadableFiles")} {state.unreadable_files.join(" ")}
              </span>
            </div>
          ) : null}
          {state.busy && (pane === "folder" || pane === "gemini") ? (
            <div className="banner banner--info" role="status">
              <span className="spinner" aria-hidden="true" />
              <span>{t("settings.busy")}</span>
            </div>
          ) : null}
          {error ? (
            <div className="banner banner--error" role="alert">
              <Icon name="warning" size={14} />
              <span>
                <ErrorText error={error.cause} />
              </span>
            </div>
          ) : null}
          <div key={pane} className="pane__view" data-switched={switched || undefined}>
            {pane === "general" ? <GeneralTab state={state} save={save} onError={report} /> : null}
            {pane === "folder" ? <FolderTab state={state} save={save} onError={report} /> : null}
            {pane === "gemini" ? <GeminiTab state={state} save={save} replace={replace} onError={report} /> : null}
            {pane === "rules" ? <RulesTab onError={report} readOnly={state.read_only || state.unreadable_files.length > 0} registerUndo={undoRule} reasons={state.reasons} /> : null}
            {pane === "reasons" ? <ReasonsTab state={state} replace={replace} onError={report} /> : null}
          </div>
        </div>
      </main>
    </div>
  );
}
