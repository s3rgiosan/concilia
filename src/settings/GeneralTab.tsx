import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ErrorText } from "../components/ErrorText";
import { FormRow, FormSection, Toggle } from "../components/Form";
import { PopUpButton } from "../components/PopUpButton";
import { useInstallUpdate } from "../lib/hooks/useInstallUpdate";
import { appVersion, checkForUpdates, popplerStatus, type Language, type PopplerStatus, type UpdateInfo } from "../lib/tauri";
import type { PaneProps } from "./types";

type LanguageChoice = Language | "system";

export function GeneralTab({ state, save, onError }: PaneProps) {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");
  const [poppler, setPoppler] = useState<PopplerStatus | { error: unknown } | null>(null);
  const disabled = state.read_only;

  useEffect(() => {
    appVersion().then(setVersion, onError);
    popplerStatus().then(setPoppler, (error) => setPoppler({ error }));
  }, [onError]);

  const languages: { value: LanguageChoice; label: string }[] = [
    { value: "system", label: t("settings.general.languageSystem") },
    { value: "en", label: t("lang.en") },
    { value: "pt", label: t("lang.pt") },
  ];

  let pdfTools: ReactNode = t("common.loading");
  if (poppler && "error" in poppler) {
    pdfTools = <ErrorText error={poppler.error} />;
  } else if (poppler) {
    pdfTools = t(poppler.bundled ? "settings.general.pdfToolsBundled" : "settings.general.pdfToolsSystem", { version: poppler.version });
  }

  return (
    <div className="form-pane">
      <FormSection footer={t("settings.general.languageHint")}>
        <FormRow label={t("settings.general.language")} htmlFor="language">
          <PopUpButton<LanguageChoice>
            id="language"
            label={t("settings.general.language")}
            value={state.settings.language ?? "system"}
            options={languages}
            disabled={disabled}
            onChange={(choice) => save((s) => ({ ...s, language: choice === "system" ? null : choice }))}
          />
        </FormRow>
      </FormSection>

      <FormSection title={t("settings.general.updatesSection")}>
        <FormRow label={t("settings.general.updates")}>
          <Toggle
            label={t("settings.general.updates")}
            checked={state.settings.check_for_updates}
            disabled={disabled}
            onChange={(on) => save((s) => ({ ...s, check_for_updates: on }))}
          />
        </FormRow>
        <FormRow label={t("settings.general.versionLabel")} description={version}>
          <UpdateCheck appBusy={state.busy} />
        </FormRow>
      </FormSection>

      <FormSection>
        <FormRow label={t("settings.general.pdfTools")}>
          <span className="value">{pdfTools}</span>
        </FormRow>
      </FormSection>
    </div>
  );
}

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; update: UpdateInfo }
  | { kind: "failed"; error: unknown }
  | { kind: "install_failed" };

/** The Check Now button with its one-line result, or the install button once a release is found. */
function UpdateCheck({ appBusy }: { appBusy: boolean }) {
  const { t } = useTranslation();
  const [state, setState] = useState<CheckState>({ kind: "idle" });
  const { busy, label, install } = useInstallUpdate(() => setState({ kind: "install_failed" }));

  function check() {
    setState({ kind: "checking" });
    checkForUpdates()
      .then((update) => setState(update ? { kind: "available", update } : { kind: "current" }))
      .catch((e) => {
        console.error(e);
        setState({ kind: "failed", error: e });
      });
  }

  let dot: string | null = null;
  let text: ReactNode = "";
  switch (state.kind) {
    case "checking":
      dot = "gray";
      text = t("settings.general.statusChecking");
      break;
    case "current":
      dot = "green";
      text = t("settings.general.statusCurrent");
      break;
    case "available":
      dot = "green";
      text = t("settings.general.statusAvailable", { version: state.update.version });
      break;
    case "failed":
      dot = "red";
      text = (
        <>
          {t("settings.general.statusFailed")}
          <span className="error-detail">
            <ErrorText error={state.error} />
          </span>
        </>
      );
      break;
    case "install_failed":
      dot = "red";
      text = t("settings.general.statusInstallFailed");
      break;
    default:
      break;
  }

  return (
    <>
      <span className="value value--status" role="status">
        {dot ? <span className={`dot dot--${dot}`} aria-hidden="true" /> : null}
        <span>{text}</span>
      </span>
      {state.kind === "available" ? (
        <button type="button" onClick={install} disabled={busy || appBusy}>
          {label}
        </button>
      ) : (
        <button type="button" onClick={check} disabled={state.kind === "checking"}>
          {t("settings.general.checkNow")}
        </button>
      )}
    </>
  );
}
