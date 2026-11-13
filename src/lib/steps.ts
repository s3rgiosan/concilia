import type { TFunction } from "i18next";
import type { RunEvent } from "./tauri";

export type StepStatus = "pending" | "running" | "done" | "failed";

export interface Step {
  id: "parse" | "receipts" | "extract" | "match" | "reimbursements" | "export";
  label: string;
  status: StepStatus;
  detail?: string;
  /** Receipts read so far, while receipts are being read. */
  progress?: { current: number; total: number };
}

/** A full reconcile, a scan for new receipts, or statements added to a month in review. */
export type RunKind = "reconcile" | "scan" | "add";

/** How a run ended, or null while it runs. */
export type RunOutcome = "succeeded" | "failed" | null;

const ORDER: Step["id"][] = ["parse", "receipts", "extract", "match", "reimbursements", "export"];

/** The steps a kind of run goes through: a scan reads no statements, and only a reconcile writes the report. */
function stepIds(kind: RunKind): Step["id"][] {
  switch (kind) {
    case "scan":
      return ORDER.filter((id) => id !== "parse" && id !== "export");
    case "add":
      return ORDER.filter((id) => id !== "export");
    case "reconcile":
    default:
      return ORDER;
  }
}

/**
 * The steps of a run and where each stands after `events`. When the run ends, every step it
 * reached counts as done, or the running one as failed.
 */
export function buildSteps(kind: RunKind, events: RunEvent[], outcome: RunOutcome, t: TFunction): Step[] {
  const labels: Record<Step["id"], string> = {
    parse: t("progress.parsingStatements"),
    receipts: t("progress.scanningReceipts"),
    extract: t("progress.extractingReceiptData"),
    match: t("progress.matching"),
    reimbursements: t("progress.reimbursements"),
    export: t("progress.generatingReport"),
  };
  const ids = stepIds(kind);
  const steps = new Map<Step["id"], Step>(ids.map((id) => [id, { id, label: labels[id], status: "pending" }]));

  /** Marks `id` running and every step before it done. Steps this kind of run lacks are ignored. */
  function reach(id: Step["id"]) {
    if (!steps.has(id)) {
      return;
    }
    for (const step of steps.values()) {
      if (step.id === id) {
        step.status = "running";
        break;
      }
      step.status = "done";
      step.progress = undefined;
    }
  }

  for (const event of events) {
    switch (event.step) {
      case "parsing": {
        reach("parse");
        const parse = steps.get("parse");
        if (parse) {
          parse.detail = event.count === 0 ? t("progress.savedTransactions") : t("progress.filesFound", { count: event.count });
        }
        break;
      }
      case "receipts_found": {
        reach("extract");
        const receipts = steps.get("receipts");
        if (receipts) {
          receipts.detail = t("progress.receiptsFound", { count: event.count });
        }
        break;
      }
      case "extracting": {
        reach("extract");
        const extract = steps.get("extract");
        if (extract) {
          extract.detail = t("progress.count", { current: event.current, total: event.total });
          extract.progress = { current: event.current, total: event.total };
        }
        break;
      }
      case "matching":
        reach("match");
        break;
      case "reimbursements_found": {
        reach("reimbursements");
        const reimbursements = steps.get("reimbursements");
        if (reimbursements) {
          reimbursements.detail = t("progress.receiptsFound", { count: event.count });
        }
        break;
      }
      case "extracting_reimbursements": {
        reach("reimbursements");
        const reimbursements = steps.get("reimbursements");
        if (reimbursements) {
          reimbursements.detail = t("progress.count", { current: event.current, total: event.total });
          reimbursements.progress = { current: event.current, total: event.total };
        }
        break;
      }
      case "exporting":
        reach("export");
        break;
      default:
        break;
    }
  }

  const list = [...steps.values()];
  if (outcome === "succeeded") {
    for (const step of list) {
      step.status = "done";
      step.progress = undefined;
    }
  } else if (outcome === "failed") {
    for (const step of list) {
      if (step.status === "running") {
        step.status = "failed";
        step.progress = undefined;
      }
    }
  }
  return list;
}
