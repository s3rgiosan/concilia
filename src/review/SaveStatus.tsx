import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { errorDetail, friendlyError } from "../lib/errors";
import type { SaveState } from "./useDraftAutosave";

/** The save state after the subtitle's status: " · Saving…", " · Saved" or a failure. */
export function SaveStatus({ state }: { state: SaveState }) {
  const { t } = useTranslation();
  switch (state.kind) {
    case "saving":
      return (
        <span className="review-save">
          <span aria-hidden="true"> · </span>
          {t("review.saveState.saving")}
        </span>
      );
    case "saved":
      return (
        <span className="review-save">
          <span aria-hidden="true"> · </span>
          {t("review.saveState.saved")}
        </span>
      );
    case "failed": {
      const detail = errorDetail(state.error);
      const reason = [friendlyError(state.error, t), detail ? t("errors.details", { detail }) : null].filter(Boolean).join(" ");
      return (
        <span className="review-save review-save--failed" role="alert" title={reason}>
          <span aria-hidden="true"> · </span>
          <Icon name="warning" size={11} /> {t("review.saveState.failed")}
          <span className="visually-hidden">: {reason}</span>
        </span>
      );
    }
    case "idle":
    default:
      return null;
  }
}
