import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FormRow, FormSection } from "../components/Form";
import { Sheet } from "../components/Sheet";
import { TextSetting } from "../components/TextSetting";
import { friendlyError } from "../lib/errors";
import { importServiceAccount, removeServiceAccount, testGeminiConnection, type AppStateView } from "../lib/tauri";
import type { PaneProps } from "./types";

type TestState = { kind: "idle" } | { kind: "testing" } | { kind: "ok" } | { kind: "failed"; message: string };

export function GeminiTab({ state, save, replace, onError }: PaneProps & { replace: (view: AppStateView) => void }) {
  const { t } = useTranslation();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const account = state.service_account;
  const locked = state.read_only || state.busy;
  const gemini = state.settings.gemini;

  function importKey() {
    setTest({ kind: "idle" });
    importServiceAccount().then((view) => {
      if (view) {
        replace(view);
      }
    }, onError);
  }

  function remove() {
    setRemoving(true);
    removeServiceAccount()
      .then((view) => {
        replace(view);
        setConfirmRemove(false);
        setTest({ kind: "idle" });
      }, onError)
      .finally(() => setRemoving(false));
  }

  function runTest() {
    setTest({ kind: "testing" });
    testGeminiConnection().then(
      () => setTest({ kind: "ok" }),
      (e) => setTest({ kind: "failed", message: friendlyError(e, t) }),
    );
  }

  let keyDescription: string;
  if (state.service_account_error) {
    keyDescription = t("settings.gemini.keyUnreadable", { message: state.service_account_error });
  } else if (account) {
    keyDescription = account.client_email;
  } else {
    keyDescription = t("settings.gemini.none");
  }


  const projectPlaceholder = account?.project_id
    ? t("settings.gemini.projectFromKey", { project: account.project_id })
    : t("settings.gemini.projectRequired");

  return (
    <>
      <FormSection footer={t("settings.gemini.keyHint")}>
        <FormRow label={t("settings.gemini.key")} description={keyDescription}>
          {account ? (
            <button type="button" className="destructive" onClick={() => setConfirmRemove(true)} disabled={locked}>
              {t("common.remove")}
            </button>
          ) : null}
          <button type="button" onClick={importKey} disabled={locked}>
            {account ? t("settings.gemini.replace") : t("settings.gemini.import")}
          </button>
        </FormRow>
      </FormSection>
      <FormSection footer={test.kind === "failed" ? test.message : undefined}>
        <FormRow label={t("settings.gemini.project")} htmlFor="project">
          <TextSetting
            id="project"
            label={t("settings.gemini.project")}
            value={gemini.project ?? ""}
            placeholder={projectPlaceholder}
            disabled={locked}
            onCommit={(project) => save((s) => ({ ...s, gemini: { ...s.gemini, project: project || null } }))}
          />
        </FormRow>
        <FormRow label={t("settings.gemini.location")} htmlFor="location">
          <TextSetting
            id="location"
            label={t("settings.gemini.location")}
            value={gemini.location}
            disabled={locked}
            onCommit={(location) => save((s) => ({ ...s, gemini: { ...s.gemini, location } }))}
          />
        </FormRow>
        <FormRow label={t("settings.gemini.model")} htmlFor="model">
          <TextSetting
            id="model"
            label={t("settings.gemini.model")}
            value={gemini.model}
            disabled={locked}
            onCommit={(model) => save((s) => ({ ...s, gemini: { ...s.gemini, model } }))}
          />
        </FormRow>
        <FormRow label="">
          <span className="value value--status" role="status" title={test.kind === "failed" ? test.message : undefined}>
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
      {confirmRemove ? (
        <Sheet
          title={t("settings.gemini.removeTitle")}
          message={t("settings.gemini.removeMessage")}
          submitLabel={t("common.remove")}
          destructive
          busy={removing}
          onCancel={() => setConfirmRemove(false)}
          onSubmit={remove}
        />
      ) : null}
    </>
  );
}
