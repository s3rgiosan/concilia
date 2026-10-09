import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import type { Step } from "../lib/steps";

function StepIcon({ status }: { status: Step["status"] }) {
  switch (status) {
    case "done":
      return <Icon name="check" size={14} className="step__icon step__icon--done" />;
    case "running":
      return <span className="spinner step__spinner" aria-hidden="true" />;
    case "failed":
      return <Icon name="warning" size={14} className="step__icon step__icon--failed" />;
    case "pending":
    default:
      return <span className="step__dot" aria-hidden="true" />;
  }
}

/** The steps of a running reconcile or scan, with a Cancel button while it runs. */
export function RunProgress({
  title,
  steps,
  running,
  cancelling,
  onCancel,
}: {
  title: string;
  steps: Step[];
  running: boolean;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="run" aria-labelledby="run-title">
      <h1 id="run-title" className="start__title">
        {title}
      </h1>
      <ol className="steps-list form-group">
        {steps.map((step) => (
          <li key={step.id} className={`step step--${step.status}`}>
            <span className="step__marker">
              <StepIcon status={step.status} />
            </span>
            <div className="grow">
              <span className="step__label">{step.label}</span>
              {step.detail ? <span className="step__detail muted"> · {step.detail}</span> : null}
              {step.progress && step.progress.total > 0 ? (
                <progress
                  className="step__progress"
                  value={step.progress.current}
                  max={step.progress.total}
                  aria-label={step.label}
                />
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {running ? (
        <footer className="start__actions">
          <span className="grow" />
          <button type="button" onClick={onCancel} disabled={cancelling}>
            {cancelling ? t("progress.cancelling") : t("progress.cancel")}
          </button>
        </footer>
      ) : null}
    </section>
  );
}
