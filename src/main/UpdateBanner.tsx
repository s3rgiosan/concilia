import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { useInstallUpdate } from "../lib/hooks/useInstallUpdate";
import { onUpdateCheckResult, pendingUpdate, subscribe, type UpdateInfo } from "../lib/tauri";

/** The version the user put off with Later; its banner stays hidden until the app quits. */
let postponed: string | null = null;

/**
 * Announces an available release and installs it on request, or hides it until the next launch
 * with Later. In the sidebar it is a compact card above the footer; in the detail area, a banner.
 */
export function UpdateBanner({ placement, onError }: { placement: "sidebar" | "detail"; onError: (e: unknown) => void }) {
  const { t } = useTranslation();
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [hidden, setHidden] = useState<string | null>(postponed);
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

  if (!update || hidden === update.version) {
    return null;
  }
  const later = () => {
    postponed = update.version;
    setHidden(update.version);
  };
  const text = t("update.available", { version: update.version });
  if (placement === "sidebar") {
    return (
      <div className="update-card" role="status">
        <p className="update-card__text">
          <Icon name="refresh" size={13} />
          <span>{text}</span>
        </p>
        <div className="update-card__actions">
          <button type="button" className="default" onClick={install} disabled={busy}>
            {label}
          </button>
          <button type="button" disabled={busy} onClick={later}>
            {t("update.later")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="banner banner--info update-banner" role="status">
      <Icon name="refresh" size={14} />
      <span className="grow">{text}</span>
      <button type="button" className="banner__action" disabled={busy} onClick={later}>
        {t("update.later")}
      </button>
      <button type="button" className="banner__action" onClick={install} disabled={busy}>
        {label}
      </button>
    </div>
  );
}
