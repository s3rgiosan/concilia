import { useTranslation } from "react-i18next";
import { Banner } from "../components/Banner";
import { ErrorText } from "../components/ErrorText";
import { needsSettings } from "../components/ErrorState";
import { errorKind } from "../lib/errors";
import type { Step } from "../lib/steps";
import { RunProgress } from "./RunProgress";

export interface RunPanelProps {
  title: string;
  steps: Step[];
  /** Why the run failed or was stopped, or null while it goes. */
  error: unknown;
  onBack: () => void;
  onOpenSettings: () => void;
  onRetry: () => void;
}

/** A reconcile's progress, and for a failed or stopped one the reason and the ways on. */
export function RunPanel({ title, steps, error, onBack, onOpenSettings, onRetry }: RunPanelProps) {
  const { t } = useTranslation();
  const cancelled = error !== null && errorKind(error) === "cancelled";
  return (
    <div className="run-panel">
      <RunProgress title={title} steps={steps} />
      {error !== null ? (
        <>
          <Banner tone={cancelled ? "info" : "error"} icon="warning" role="alert">
            <ErrorText error={error} />
          </Banner>
          <div className="run__actions">
            <button type="button" onClick={onBack}>
              {t("month.backToStatements")}
            </button>
            {needsSettings(error) ? (
              <button type="button" onClick={onOpenSettings}>
                {t("common.openSettings")}
              </button>
            ) : null}
            <button type="button" className="default" onClick={onRetry}>
              {t("common.tryAgain")}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
