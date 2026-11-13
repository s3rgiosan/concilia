import type { TFunction } from "i18next";
import type { AlertRequest } from "../lib/tauri";

/** The alert that confirms re-running a month, which undoes the sorting of its receipts. */
export function rerunAlert(period: string, t: TFunction): AlertRequest {
  return {
    title: t("rerun.title", { period }),
    message: t("rerun.message"),
    confirm: t("rerun.confirm"),
    cancel: t("common.cancel"),
  };
}
