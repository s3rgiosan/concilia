import type { ReactNode } from "react";
import { errorKind } from "../lib/errors";
import { ErrorText } from "./ErrorText";
import { Icon } from "./Icon";

/** Whether a failure is fixed in Settings, so the UI offers Open Settings… next to Try Again. */
export function needsSettings(error: unknown): boolean {
  const kind = errorKind(error);
  switch (kind) {
    case "unauthorized":
    case "not_configured":
    case "keychain":
      return true;
    default:
      return false;
  }
}

/**
 * A failure that leaves a pane empty, centred in it: a warning symbol, a title, the reason and
 * the actions that recover from it.
 */
export function ErrorState({ title, error, children }: { title: string; error: unknown; children?: ReactNode }) {
  return (
    <div className="error-state" role="alert">
      <Icon name="warning" size={32} className="error-state__icon" />
      <h2 className="error-state__title">{title}</h2>
      <p className="error-state__message">
        <ErrorText error={error} />
      </p>
      {children ? <div className="error-state__actions">{children}</div> : null}
    </div>
  );
}
