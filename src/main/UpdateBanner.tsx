import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { useInstallUpdate } from "../lib/hooks/useInstallUpdate";
import { onUpdateCheckResult, pendingUpdate, subscribe, type UpdateInfo } from "../lib/tauri";

/** Announces an available release and installs it on request. */
export function UpdateBanner({ onError }: { onError: (e: unknown) => void }) {
  const { t } = useTranslation();
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const { busy, label, install } = useInstallUpdate(onError);

  useEffect(() => {
    pendingUpdate().then(setUpdate, () => undefined);
    return subscribe(
      onUpdateCheckResult((result) => {
        if (result.update) {
          setUpdate(result.update);
        }
      }),
    );
  }, []);

  if (!update) {
    return null;
  }
  return (
    <div className="banner banner--info update-banner" role="status">
      <Icon name="refresh" size={14} />
      <span className="grow">{t("update.available", { version: update.version })}</span>
      <button type="button" className="banner__action" onClick={install} disabled={busy}>
        {label}
      </button>
    </div>
  );
}
