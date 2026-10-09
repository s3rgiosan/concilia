import "./Main.css";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { friendlyError } from "../lib/errors";
import { useAppState } from "../lib/hooks/useAppState";
import { SetupEmptyState } from "./SetupEmptyState";
import { UpdateBanner } from "./UpdateBanner";

/** The main window: setup steps until the app is configured, then the reconciliation flow. */
export function Main() {
  const { t } = useTranslation();
  const { state, error: loadError, reload } = useAppState();
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((e: unknown) => setError(friendlyError(e, t)), [t]);

  return (
    <div className="main">
      <UpdateBanner onError={report} />
      {loadError || error ? (
        <div className="banner banner--error" role="alert">
          <Icon name="warning" size={14} />
          <span className="grow">{loadError ? friendlyError(loadError, t) : error}</span>
          {loadError ? (
            <button type="button" className="banner__action" onClick={reload}>
              {t("common.tryAgain")}
            </button>
          ) : null}
        </div>
      ) : null}
      {state && !state.configured ? <SetupEmptyState missing={state.missing} onError={report} /> : null}
    </div>
  );
}
