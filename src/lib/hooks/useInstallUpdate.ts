import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { installUpdate, onUpdateProgress, subscribe, type UpdateProgress } from "../tauri";
import { useLatest } from "./useLatest";

/** Download progress, or "installing" once every byte has arrived. Null while idle. */
type Phase = UpdateProgress | "installing" | null;

/**
 * Drives the install button: starts the install, follows the download progress and reports a
 * failure through `onError`. The app relaunches on success, so a finished install needs no state.
 */
export function useInstallUpdate(onError: (e: unknown) => void): { busy: boolean; label: string; install: () => void } {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>(null);
  const report = useLatest(onError);

  useEffect(
    () =>
      subscribe(
        onUpdateProgress((progress) => {
          setPhase((prev) => {
            if (prev === null) {
              return prev;
            }
            const done = progress.total !== null && progress.total > 0 && progress.downloaded >= progress.total;
            return done ? "installing" : progress;
          });
        }),
      ),
    [],
  );

  const install = useCallback(() => {
    setPhase({ downloaded: 0, total: null });
    installUpdate().catch((e) => {
      setPhase(null);
      report.current(e);
    });
  }, [report]);

  let label: string;
  if (phase === null) {
    label = t("update.install");
  } else if (phase === "installing") {
    label = t("update.installing");
  } else if (phase.total === null || phase.total <= 0) {
    label = t("update.downloading");
  } else {
    label = t("update.downloadingPercent", { percent: Math.min(100, Math.floor((phase.downloaded / phase.total) * 100)) });
  }

  return { busy: phase !== null, label, install };
}
