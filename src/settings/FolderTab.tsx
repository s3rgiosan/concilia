import { Trans, useTranslation } from "react-i18next";
import { FormRow, FormSection } from "../components/Form";
import { Icon } from "../components/Icon";
import { pickReceiptsRoot } from "../lib/tauri";
import type { PaneProps } from "./types";

export function FolderTab({ state, save, onError }: PaneProps) {
  const { t } = useTranslation();
  const root = state.settings.receipts_root;
  const missing = root !== null && state.missing.includes("receipts_root");
  const locked = state.read_only || state.busy;

  function choose() {
    pickReceiptsRoot().then((picked) => {
      if (picked) {
        save((s) => ({ ...s, receipts_root: picked }));
      }
    }, onError);
  }

  return (
    <FormSection footer={<Trans i18nKey="settings.folder.hint" components={{ code: <code /> }} />}>
      <FormRow
        label={t("settings.folder.receiptsRoot")}
        description={
          missing ? (
            <span className="muted">
              <Icon name="warning" size={11} /> {t("settings.folder.missing")}
            </span>
          ) : undefined
        }
      >
        <span className="path" title={root ?? undefined}>
          {root ?? t("settings.folder.notSet")}
        </span>
        <button type="button" onClick={choose} disabled={locked}>
          {t("common.choose")}
        </button>
      </FormRow>
    </FormSection>
  );
}
