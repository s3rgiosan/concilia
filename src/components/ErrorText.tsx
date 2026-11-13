import { useTranslation } from "react-i18next";
import { errorDetail, friendlyError } from "../lib/errors";

/** The sentence for a failure, with the backend's own words in a secondary line below. */
export function ErrorText({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const detail = errorDetail(error);
  return (
    <>
      {friendlyError(error, t)}
      {detail ? <span className="error-detail">{t("errors.details", { detail })}</span> : null}
    </>
  );
}
