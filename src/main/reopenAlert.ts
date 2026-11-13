import type { TFunction } from "i18next";
import type { AlertRequest } from "../lib/tauri";

/** The alert that confirms reopening a finalized month, which moves its sorted receipts back. */
export function reopenAlert(period: string, t: TFunction): AlertRequest {
  return {
    title: t("reopen.title", { period }),
    message: t("reopen.message"),
    confirm: t("reopen.confirm"),
    cancel: t("common.cancel"),
  };
}
