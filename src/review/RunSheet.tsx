import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ErrorText } from "../components/ErrorText";
import { needsSettings } from "../components/ErrorState";
import { Icon } from "../components/Icon";
import { useModal } from "../components/Sheet";
import type { Step } from "../lib/steps";
import { RunProgress } from "../main/RunProgress";

/**
 * The progress of a run inside the review, such as a scan for new receipts, as a sheet. While it
 * runs, Cancel (or Esc) stops it. After a failure it shows why, with Open Settings… when the fix
 * is there and Try Again, until closed.
 */
export function RunSheet({
  title,
  steps,
  running,
  cancelling,
  error,
  onCancel,
  onClose,
  onRetry,
  onOpenSettings,
}: {
  title: string;
  steps: Step[];
  running: boolean;
  cancelling: boolean;
  /** Why the run failed, or null while it runs. */
  error: unknown;
  onCancel: () => void;
  onClose: () => void;
  onRetry: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  const backdrop = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useModal(backdrop, panel, running ? onCancel : onClose, { busy: cancelling, initialFocus: "button.default, button" });

  // Cancel goes away when the run fails, so focus moves to Try Again.
  useEffect(() => {
    if (!running) {
      panel.current?.querySelector<HTMLElement>("button.default")?.focus();
    }
  }, [running]);

  return (
    <div className="sheet-backdrop" ref={backdrop}>
      <div ref={panel} className="sheet sheet--wide" role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="sheet__title">{title}</h2>
        <RunProgress steps={steps} />
        {running ? null : (
          <div className="banner banner--error" role="alert">
            <Icon name="warning" size={14} />
            <span className="grow">
              <ErrorText error={error} />
            </span>
          </div>
        )}
        <div className="sheet__actions">
          {running ? (
            <button type="button" onClick={onCancel} disabled={cancelling}>
              {cancelling ? t("progress.cancelling") : t("common.cancel")}
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose}>
                {t("common.close")}
              </button>
              {needsSettings(error) ? (
                <button type="button" onClick={onOpenSettings}>
                  {t("common.openSettings")}
                </button>
              ) : null}
              <button type="button" className="default" onClick={onRetry}>
                {t("common.tryAgain")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
