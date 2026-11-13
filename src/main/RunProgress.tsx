import { useId, type CSSProperties } from "react";
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

/**
 * A determinate progress bar whose fill glides to each new value, so steps of a few items read as
 * one continuous movement.
 */
function ProgressBar({ label, detail, current, total }: { label: string; detail?: string; current: number; total: number }) {
  const fraction = Math.min(1, Math.max(0, current / total));
  return (
    <span
      className="step__progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={current}
      aria-valuetext={detail}
      style={{ "--progress": fraction } as CSSProperties}
    >
      <span className="step__progress-fill" />
    </span>
  );
}

/** The steps of a running reconcile or scan, under an optional title. */
export function RunProgress({ title, steps }: { title?: string; steps: Step[] }) {
  const titleId = useId();
  return (
    <section className="run" aria-labelledby={title ? titleId : undefined}>
      {title ? (
        <h2 id={titleId} className="run__title">
          {title}
        </h2>
      ) : null}
      <ol className="steps-list form-group">
        {steps.map((step) => (
          <li key={step.id} className={`step step--${step.status}`}>
            <span className="step__marker">
              <StepIcon status={step.status} />
            </span>
            <div className="grow">
              <span className="step__label">{step.label}</span>
              {step.detail ? (
                <span className="step__detail muted">
                  <span aria-hidden="true"> · </span>
                  {step.detail}
                </span>
              ) : null}
              {step.progress && step.progress.total > 0 ? <ProgressBar label={step.label} detail={step.detail} {...step.progress} /> : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
