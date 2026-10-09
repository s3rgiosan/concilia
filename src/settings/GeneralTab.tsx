import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FormRow, FormSection, Toggle } from "../components/Form";
import { PopUpButton } from "../components/PopUpButton";
import { friendlyError } from "../lib/errors";
import { appVersion, checkForUpdates, popplerStatus, type Language, type PopplerStatus } from "../lib/tauri";
import type { PaneProps } from "./types";

type LanguageChoice = Language | "system";

export function GeneralTab({ state, save, onError }: PaneProps) {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");
  const [poppler, setPoppler] = useState<PopplerStatus | string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const disabled = state.read_only;

  useEffect(() => {
    appVersion().then(setVersion, onError);
    popplerStatus().then(setPoppler, (e) => setPoppler(friendlyError(e, t)));
  }, [onError, t]);

  function checkNow() {
    setChecking(true);
    setCheckResult(null);
    checkForUpdates()
      .then(
        (update) => setCheckResult(update ? t("update.available", { version: update.version }) : t("settings.general.upToDate")),
        (e) => setCheckResult(friendlyError(e, t)),
      )
      .finally(() => setChecking(false));
  }

  const languages: { value: LanguageChoice; label: string }[] = [
    { value: "system", label: t("settings.general.languageSystem") },
    { value: "en", label: t("lang.en") },
    { value: "pt", label: t("lang.pt") },
  ];

  let pdfTools = "";
  if (typeof poppler === "string") {
    pdfTools = poppler;
  } else if (poppler) {
    pdfTools = t(poppler.bundled ? "settings.general.pdfToolsBundled" : "settings.general.pdfToolsSystem", { version: poppler.version });
  }

  return (
    <>
      <FormSection>
        <FormRow label={t("settings.general.language")} htmlFor="language" description={t("settings.general.languageHint")}>
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
      <FormSection footer={checkResult ?? undefined}>
        <FormRow label={t("settings.general.updates")} htmlFor="updates">
          <Toggle
            id="updates"
            label={t("settings.general.updates")}
            checked={state.settings.check_for_updates}
            disabled={disabled}
            onChange={(on) => save((s) => ({ ...s, check_for_updates: on }))}
          />
        </FormRow>
        <FormRow label={t("settings.general.version", { version })}>
          <button type="button" onClick={checkNow} disabled={checking}>
            {checking ? t("settings.general.checking") : t("settings.general.checkNow")}
          </button>
        </FormRow>
      </FormSection>
      <FormSection>
        <FormRow label={t("settings.general.pdfTools")} description={pdfTools || t("common.loading")} />
      </FormSection>
    </>
  );
}
