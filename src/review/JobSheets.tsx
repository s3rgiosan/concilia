import { useTranslation } from "react-i18next";
import { Presence } from "../components/Presence";
import type { RunState } from "../lib/hooks/useRun";
import type { Statement } from "../lib/statements";
import { buildSteps } from "../lib/steps";
import { AddStatementsSheet } from "./AddStatementsSheet";
import { RunSheet } from "./RunSheet";
import type { JobKind, JobOutcome } from "./useReviewJobs";

/** The statements chosen in the Add Statements sheet, and a file it turned away. */
export type Adding = { files: Statement[]; rejected: string | null };

export interface JobSheetsProps {
  /** The month in a sentence, such as "October 2026". */
  period: string;
  kind: JobKind;
  state: RunState<JobOutcome>;
  adding: Adding | null;
  /** The statements the month already holds. */
  existing: Parameters<typeof AddStatementsSheet>[0]["existing"];
  onCancel: () => void;
  onClose: () => void;
  onRetry: () => void;
  onOpenSettings: () => void;
  onFiles: (files: Statement[]) => void;
  onChoose: () => void;
  onCancelAdding: () => void;
  onAdd: () => void;
}

/** The sheet of a running or failed scan or add, or else the Add Statements sheet. */
export function JobSheets({ period, kind, state, adding, existing, onCancel, onClose, onRetry, onOpenSettings, onFiles, onChoose, onCancelAdding, onAdd }: JobSheetsProps) {
  const { t } = useTranslation();
  return (
    <Presence>
      {state.phase === "running" || state.phase === "failed" ? (
        <RunSheet
          title={kind === "scan" ? t("review.scan") : t("review.addStatements.running")}
          steps={buildSteps(kind, state.events, state.phase === "failed" ? "failed" : null, t)}
          running={state.phase === "running"}
          cancelling={state.phase === "running" && state.cancelling}
          error={state.phase === "failed" ? state.error : null}
          onCancel={onCancel}
          onClose={onClose}
          onRetry={onRetry}
          onOpenSettings={onOpenSettings}
        />
      ) : adding ? (
        <AddStatementsSheet
          period={period}
          existing={existing}
          files={adding.files}
          rejected={adding.rejected}
          onFiles={onFiles}
          onChoose={onChoose}
          onCancel={onCancelAdding}
          onAdd={onAdd}
        />
      ) : null}
    </Presence>
  );
}
