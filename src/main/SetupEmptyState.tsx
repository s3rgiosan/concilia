import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { openSettings, type Missing } from "../lib/tauri";

/** Lists what is left to set up before a month can be reconciled. */
export function SetupEmptyState({ missing, onError }: { missing: Missing[]; onError: (e: unknown) => void }) {
  const { t } = useTranslation();
  return (
    <section className="setup" aria-labelledby="setup-title">
      <Icon name="gear" size={40} className="setup__icon" />
      <h1 id="setup-title" className="setup__title">
        {t("setup.title")}
      </h1>
      <p className="setup__intro">{t("setup.intro")}</p>
      <ol className="setup__steps">
        {missing.map((item) => (
          <li key={item}>{t(`setup.${item}`)}</li>
        ))}
      </ol>
      <button type="button" className="default" onClick={() => openSettings().catch(onError)}>
        {t("setup.openSettings")}
      </button>
    </section>
  );
}
