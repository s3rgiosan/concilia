import { useImperativeHandle, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { PopUpButton } from "../components/PopUpButton";
import { useFileDrop } from "../lib/hooks/useFileDrop";
import type { Period } from "../lib/period";
import { popUpMenu } from "../lib/popUpMenu";
import { pickStatements, type PeriodSummary, type StatementInput } from "../lib/tauri";

/** Banks Concilia can parse, as the backend's `Bank` keys. */
export const BANKS = [{ value: "cgd", label: "CGD" }];

export interface Statement extends StatementInput {
  id: string;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function isPdf(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}

/** The month's receipts folder under the receipts root. */
export function receiptsFolder(root: string, period: Period): string {
  return `${root.replace(/[\\/]+$/, "")}/${period.year}/${period.month}/receipts`;
}

/**
 * A month that has not been matched yet: a drop zone for its bank statements, the statements
 * added so far and, for an empty month, where its receipts go.
 */
export function Statements({
  ref,
  period,
  summary,
  receiptsRoot,
  statements,
  onStatements,
  onReveal,
  onError,
}: {
  /** Lets the app menu open the file picker. */
  ref?: Ref<{ browse: () => void }>;
  period: Period;
  summary: PeriodSummary;
  receiptsRoot: string | null;
  statements: Statement[];
  onStatements: (statements: Statement[]) => void;
  onReveal: () => void;
  onError: (e: unknown) => void;
}) {
  const { t, i18n } = useTranslation();
  const [rejected, setRejected] = useState<string | null>(null);

  function add(paths: string[]) {
    const pdfs = paths.filter(isPdf);
    const firstRejected = paths.find((p) => !isPdf(p));
    setRejected(firstRejected === undefined ? null : fileName(firstRejected));
    const known = new Set(statements.map((s) => s.path));
    const fresh = pdfs.filter((p) => !known.has(p)).map((path) => ({ id: crypto.randomUUID(), path, bank: BANKS[0].value }));
    if (fresh.length > 0) {
      onStatements([...statements, ...fresh]);
    }
  }

  const dragging = useFileDrop(add);

  function browse() {
    pickStatements().then((paths) => {
      if (paths.length > 0) {
        add(paths);
      }
    }, onError);
  }

  useImperativeHandle(ref, () => ({ browse }));

  // Portuguese writes month names in lower case inside a sentence.
  const name = t(`form.months.${period.month}`);
  const month = i18n.language === "pt" ? name.toLocaleLowerCase("pt") : name;
  const hint = t("month.dropHint", { month });
  const addButton = (
    <button type="button" onClick={browse}>
      {t("month.addStatements")}
    </button>
  );

  return (
    <section className="statements" aria-label={t("month.statements")}>
      <div className={`dropzone ${dragging ? "dropzone--over" : ""}`}>
        {statements.length === 0 ? (
          <div className="dropzone__empty">
            <Icon name="drop" size={36} className="dropzone__icon" />
            <p className="dropzone__hint">{hint}</p>
            {addButton}
          </div>
        ) : (
          <>
            <ul className="statements__list" aria-label={t("month.statements")}>
              {statements.map((statement) => {
                const name = fileName(statement.path);
                const removeLabel = t("month.removeStatement", { name });
                const remove = () => onStatements(statements.filter((s) => s.id !== statement.id));
                return (
                <li
                  key={statement.id}
                  className="statements__row"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    void popUpMenu([{ label: t("month.remove"), onSelect: remove }], { x: e.clientX, y: e.clientY });
                  }}
                >
                  <Icon name="doc" size={14} />
                  <span className="grow statements__name" title={statement.path}>
                    {name}
                  </span>
                  {BANKS.length > 1 ? (
                    <PopUpButton
                      label={t("month.bankFor", { name })}
                      value={statement.bank}
                      options={BANKS}
                      onChange={(bank) => onStatements(statements.map((s) => (s.id === statement.id ? { ...s, bank } : s)))}
                    />
                  ) : null}
                  <button type="button" className="icon" aria-label={removeLabel} title={removeLabel} onClick={remove}>
                    <Icon name="xmark" size={12} />
                  </button>
                </li>
                );
              })}
            </ul>
            <div className="dropzone__footer">
              <span className="muted grow">{hint}</span>
              {addButton}
            </div>
          </>
        )}
      </div>
      {rejected !== null ? <p className="statements__note muted">{t("month.notPdf", { name: rejected })}</p> : null}
      {summary.status === "empty" && receiptsRoot ? (
        <div className="receipts-hint">
          <Icon name="folder" size={14} className="receipts-hint__icon" />
          <span className="grow">{t("month.receiptsHint", { path: receiptsFolder(receiptsRoot, period) })}</span>
          <button type="button" onClick={onReveal}>
            {t("month.showInFinder")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
