import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FormRow, FormSection } from "../components/Form";
import { Icon } from "../components/Icon";
import type { Period } from "../lib/period";
import { importServiceAccount, openKeyHelp, openSettings, pickReceiptsRoot, saveSettings, type AppStateView } from "../lib/tauri";

function StatusLine({ tone, children }: { tone: "green" | "orange" | "gray"; children: ReactNode }) {
  return (
    <span className="status-line">
      <span className={`dot dot--${tone}`} aria-hidden="true" />
      <span className="status-line__label">{children}</span>
    </span>
  );
}

function baseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/**
 * First run: the receipts folder and the Gemini key, each with its status and the button that
 * sets or changes it, a link to the help on getting a key, then the folder layout Concilia
 * expects. The project row shows only when the key names no project.
 */
export function Welcome({
  state,
  period,
  onState,
  onError,
}: {
  state: AppStateView;
  period: Period;
  onState: (view: AppStateView) => void;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [working, setWorking] = useState<"folder" | "key" | null>(null);
  const root = state.settings.receipts_root;
  const locked = state.busy || state.read_only || working !== null;

  function chooseFolder() {
    setWorking("folder");
    pickReceiptsRoot()
      .then((path) => (path ? saveSettings({ ...state.settings, receipts_root: path }).then(onState) : undefined))
      .catch(onError)
      .finally(() => setWorking(null));
  }

  function importKey() {
    setWorking("key");
    importServiceAccount()
      .then((view) => {
        if (view) {
          onState(view);
        }
      })
      .catch(onError)
      .finally(() => setWorking(null));
  }

  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <h1 id="welcome-title" className="welcome__title">
        {t("welcome.title")}
      </h1>
      <p className="welcome__intro">{t("welcome.intro")}</p>
      <FormSection
        footer={
          state.service_account ? undefined : (
            <button type="button" className="link" onClick={() => openKeyHelp().catch(onError)}>
              {t("welcome.keyHelp")}
            </button>
          )
        }
      >
        <FormRow
          label={t("welcome.receiptsFolder")}
          help={root ? <StatusLine tone="green">{root}</StatusLine> : <StatusLine tone="gray">{t("welcome.notChosen")}</StatusLine>}
        >
          <button type="button" onClick={chooseFolder} disabled={locked}>
            {working === "folder" ? t("common.working") : root ? t("welcome.change") : t("common.choose")}
          </button>
        </FormRow>
        <FormRow
          label={t("welcome.geminiKey")}
          help={
            state.service_account ? (
              <StatusLine tone="green">{t("welcome.imported")}</StatusLine>
            ) : (
              <StatusLine tone="gray">{t("welcome.notImported")}</StatusLine>
            )
          }
        >
          <button type="button" onClick={importKey} disabled={locked}>
            {working === "key" ? t("common.working") : state.service_account ? t("welcome.replace") : t("welcome.import")}
          </button>
        </FormRow>
        {state.missing.includes("project") ? (
          <FormRow label={t("welcome.project")} help={<StatusLine tone="orange">{t("welcome.projectMissing")}</StatusLine>}>
            <button type="button" onClick={() => openSettings().catch(onError)}>
              {t("welcome.openSettings")}
            </button>
          </FormRow>
        ) : null}
      </FormSection>
      <figure className="welcome__layout">
        <figcaption className="welcome__caption">{t("welcome.layoutTitle")}</figcaption>
        <ul className="tree" aria-label={t("welcome.layoutTitle")}>
          <li>
            <span className="tree__item">
              <Icon name="folder" size={14} />
              {root ? baseName(root) : t("welcome.layoutRoot")}
            </span>
            <ul>
              <li>
                <span className="tree__item">
                  <Icon name="folder" size={14} />
                  {period.year}
                </span>
                <ul>
                  <li>
                    <span className="tree__item">
                      <Icon name="folder" size={14} />
                      {period.month}
                    </span>
                    <ul>
                      <li>
                        <span className="tree__item tree__item--target">
                          <Icon name="folder" size={14} />
                          receipts
                          <span className="tree__note">{t("welcome.layoutNote")}</span>
                        </span>
                      </li>
                    </ul>
                  </li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
      </figure>
    </section>
  );
}
