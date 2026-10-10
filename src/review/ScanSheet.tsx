import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ErrorText } from "../components/ErrorText";
import { Icon } from "../components/Icon";
import { useModal } from "../components/Sheet";
import type { Step } from "../lib/steps";
import { RunProgress } from "../main/RunProgress";

/**
 * The progress of a scan for new receipts, as a sheet. While it runs, Cancel (or Esc) stops it;
 * after a failure it shows why until closed.
 */
export function ScanSheet({
  steps,
  running,
  cancelling,
  error,
  onCancel,
  onClose,
}: {
  steps: Step[];
  running: boolean;
  cancelling: boolean;
  /** Why the scan failed, or null while it runs. */
  error: unknown;
  onCancel: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const backdrop = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const title = t("review.scan");
  useModal(backdrop, panel, running ? onCancel : onClose, { busy: cancelling, initialFocus: "button.default, button" });

  // Cancel goes away when the scan fails, so focus moves to Close.
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
            <button type="button" className="default" onClick={onClose}>
              {t("common.close")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
