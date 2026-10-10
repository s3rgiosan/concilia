import { useEffect, useRef } from "react";
import { errorKind } from "../errors";
import { isPreview } from "../preview";
import { requestAttention, setDockProgress, type RunEvent } from "../tauri";
import type { RunState } from "./useRun";

/** The percentage of receipts read so far, or "indeterminate" before the first count. */
function progressOf(events: RunEvent[]): number | "indeterminate" {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.step === "extracting" && event.total > 0) {
      return (event.current / event.total) * 100;
    }
  }
  return "indeterminate";
}

function report(call: () => Promise<void>) {
  try {
    call().catch((e) => console.error("could not update the Dock", e));
  } catch (e) {
    console.error("could not update the Dock", e);
  }
}

/**
 * Shows a run's progress on the Dock icon and clears it when the run ends. A run that finishes
 * (or fails) while the window is in the background bounces the icon once.
 */
export function useDockProgress(state: RunState<unknown>) {
  const wasRunning = useRef(false);
  const shown = useRef<number | "indeterminate" | null>(null);

  useEffect(() => {
    if (isPreview()) {
      return;
    }
    if (state.phase === "running") {
      const progress = progressOf(state.events);
      if (shown.current !== progress) {
        shown.current = progress;
        report(() => setDockProgress(progress));
      }
      wasRunning.current = true;
      return;
    }
    if (shown.current !== null) {
      shown.current = null;
      report(() => setDockProgress(null));
    }
    const finished = wasRunning.current;
    wasRunning.current = false;
    if (!finished || document.hasFocus()) {
      return;
    }
    if (state.phase === "succeeded" || (state.phase === "failed" && errorKind(state.error) !== "cancelled")) {
      report(requestAttention);
    }
  }, [state]);

  useEffect(
    () => () => {
      if (shown.current !== null) {
        shown.current = null;
        report(() => setDockProgress(null));
      }
    },
    [],
  );
}
