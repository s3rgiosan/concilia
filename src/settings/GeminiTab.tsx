import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ErrorText } from "../components/ErrorText";
import { FormRow, FormSection } from "../components/Form";
import { Icon } from "../components/Icon";
import { TextSetting } from "../components/TextSetting";
import { useSafeStorage } from "../lib/hooks/useSafeStorage";
import { importServiceAccount, removeServiceAccount, showAlert, testGeminiConnection, type AppStateView, type GeminiSettings } from "../lib/tauri";
import type { PaneProps } from "./types";

const REGIONS = ["europe-west1", "europe-west4", "europe-west9", "us-central1", "us-east4", "asia-southeast1"];
const MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"];

type TestState = { kind: "idle" } | { kind: "testing" } | { kind: "ok" } | { kind: "failed"; error: unknown };

export function GeminiTab({ state, save, replace, onError }: PaneProps & { replace: (view: AppStateView) => void }) {
  const { t } = useTranslation();
  const [removing, setRemoving] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const account = state.service_account;
  const locked = state.read_only || state.busy;
  const gemini = state.settings.gemini;
  const [advancedSetting, setAdvancedSetting] = useSafeStorage("settings.geminiAdvanced", "collapsed");
  const advanced = advancedSetting === "expanded";
  const advancedId = useId();

  /** Saves a connection setting and drops the test result, which no longer matches it. */
  function saveConnection(update: (g: GeminiSettings) => GeminiSettings) {
    setTest({ kind: "idle" });
    save((s) => ({ ...s, gemini: update(s.gemini) }));
  }

  function importKey() {
    setTest({ kind: "idle" });
    importServiceAccount().then((view) => {
      if (view) {
        replace(view);
      }
    }, onError);
  }

  /** Confirms removing the key in a native alert, then removes it. */
  function askRemove() {
    showAlert({
      title: t("settings.gemini.removeTitle"),
      message: t("settings.gemini.removeMessage"),
      confirm: t("settings.gemini.removeConfirm"),
      cancel: t("common.cancel"),
    }).then((choice) => {
      if (choice === "confirm") {
        remove();
      }
    }, onError);
  }

  function remove() {
    setRemoving(true);
    removeServiceAccount()
      .then((view) => {
        replace(view);
        setTest({ kind: "idle" });
      }, onError)
      .finally(() => setRemoving(false));
  }

  function runTest() {
    setTest({ kind: "testing" });
    testGeminiConnection().then(
      () => setTest({ kind: "ok" }),
      (error) => setTest({ kind: "failed", error }),
    );
  }

  let keyDescription: ReactNode;
  if (state.service_account_error) {
    keyDescription = (
      <>
        {t("settings.gemini.keyUnreadable")}
        <span className="error-detail">{t("errors.details", { detail: state.service_account_error })}</span>
      </>
    );
  } else if (account) {
    keyDescription = account.client_email;
  } else {
    keyDescription = t("settings.gemini.none");
  }

  const testFailure = test.kind === "failed" ? test.error : null;
  const projectPlaceholder = account?.project_id
    ? t("settings.gemini.projectFromKey", { project: account.project_id })
    : t("settings.gemini.projectRequired");

  return (
    <>
      <FormSection footer={t("settings.gemini.keyHint")}>
        <FormRow label={t("settings.gemini.key")} description={keyDescription}>
          {account ? (
            <button type="button" className="destructive" onClick={askRemove} disabled={locked || removing}>
              {t("settings.gemini.remove")}
            </button>
          ) : null}
          <button type="button" onClick={importKey} disabled={locked}>
            {account ? t("settings.gemini.replace") : t("settings.gemini.import")}
          </button>
        </FormRow>
      </FormSection>
      <FormSection footer={testFailure !== null ? <ErrorText error={testFailure} /> : undefined}>
        <FormRow label={t("settings.gemini.project")} htmlFor="project">
          <TextSetting
            id="project"
            label={t("settings.gemini.project")}
            value={gemini.project ?? ""}
            placeholder={projectPlaceholder}
            disabled={locked}
            onCommit={(project) => saveConnection((g) => ({ ...g, project: project || null }))}
          />
        </FormRow>
        <FormRow label={t("settings.gemini.connection")}>
          <span className="value value--status" role="status">
            {test.kind === "ok" ? (
              <>
                <span className="dot dot--green" aria-hidden="true" />
                {t("settings.gemini.connected")}
              </>
            ) : null}
            {test.kind === "failed" ? (
              <>
                <span className="dot dot--red" aria-hidden="true" />
                {t("settings.gemini.testFailed")}
              </>
            ) : null}
          </span>
          <button type="button" onClick={runTest} disabled={!account || test.kind === "testing"}>
            {test.kind === "testing" ? t("settings.gemini.testing") : t("settings.gemini.test")}
          </button>
        </FormRow>
      </FormSection>
      <section className="disclosure-section">
        <button
          type="button"
          className="disclosure"
          aria-expanded={advanced}
          aria-controls={advancedId}
          onClick={() => setAdvancedSetting(advanced ? "collapsed" : "expanded")}
        >
          <Icon name="disclosure" size={10} className="disclosure__icon" />
          {t("settings.gemini.advanced")}
        </button>
        {advanced ? (
          <div id={advancedId} className="form-group">
            <FormRow label={t("settings.gemini.region")} htmlFor="location">
              <TextSetting
                id="location"
                label={t("settings.gemini.region")}
                value={gemini.location}
                placeholder="europe-west1"
                suggestions={REGIONS}
                disabled={locked}
                onCommit={(location) => saveConnection((g) => ({ ...g, location }))}
              />
            </FormRow>
            <FormRow label={t("settings.gemini.model")} htmlFor="model">
              <TextSetting
                id="model"
                label={t("settings.gemini.model")}
                value={gemini.model}
                placeholder="gemini-2.5-flash"
                suggestions={MODELS}
                disabled={locked}
                onCommit={(model) => saveConnection((g) => ({ ...g, model }))}
              />
            </FormRow>
          </div>
        ) : null}
      </section>
    </>
  );
}
