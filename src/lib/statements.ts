// Bank statements chosen for a month, before they are added.

import type { StatementInput } from "./tauri";

/** Banks Concilia can parse, as the backend's `Bank` keys. */
export const BANKS = [{ value: "cgd", label: "CGD" }];

export interface Statement extends StatementInput {
  id: string;
}

/** Whether a path names a PDF. */
export function isPdf(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}

/** The label of a bank key, such as "CGD". */
export function bankLabel(bank: string): string {
  return BANKS.find((b) => b.value === bank)?.label ?? bank.toUpperCase();
}

/** New statements for `paths`, each with the first bank, skipping paths already in `known`. */
export function newStatements(paths: string[], known: Statement[]): Statement[] {
  const taken = new Set(known.map((s) => s.path));
  return paths.filter((p) => !taken.has(p)).map((path) => ({ id: crypto.randomUUID(), path, bank: BANKS[0].value }));
}
