import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { PopUpButton } from "../components/PopUpButton";
import { Sheet, SheetNote } from "../components/Sheet";
import type { StatementRecord } from "../lib/tauri";
import { bankLabel, BANKS, fileName, type Statement } from "../main/Statements";

/**
 * Adds bank statements to a month in review: the statements the month already holds with their
 * bank and transaction count, then the files to add, each with its bank. Choose Files… and
 * dropped files add to the list; Add runs once there is at least one.
 */
export function AddStatementsSheet({
  period,
  existing,
  files,
  rejected,
  onFiles,
  onChoose,
  onCancel,
  onAdd,
}: {
  /** The month's name inside a sentence, such as "March 2030". */
  period: string;
  existing: StatementRecord[];
  files: Statement[];
  /** A file that was not added because it is not a PDF. */
  rejected: string | null;
  onFiles: (files: Statement[]) => void;
  onChoose: () => void;
  onCancel: () => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet
      title={t("review.addStatements.title", { period })}
      submitLabel={t("common.add")}
      submitDisabled={files.length === 0}
      onCancel={onCancel}
      onSubmit={onAdd}
      width={480}
      accessory={
        <button type="button" onClick={onChoose}>
          {t("review.addStatements.choose")}
        </button>
      }
    >
      {existing.length > 0 ? (
        <section className="add-statements__section">
          <h3 className="form-section__title">{t("review.addStatements.existing")}</h3>
          <ul className="form-group add-statements__list" aria-label={t("review.addStatements.existing")}>
            {existing.map((statement) => (
              <li key={`${statement.file}-${statement.added_at}`} className="statements__row">
                <Icon name="doc" size={14} />
                <span className="grow statements__name" title={statement.file}>
                  {statement.file}
                </span>
                <span className="muted">{bankLabel(statement.bank)}</span>
                <span className="muted numeric add-statements__count">{t("month.summary.transactions", { count: statement.transactions })}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="add-statements__section">
        <h3 className="form-section__title">{t("review.addStatements.new")}</h3>
        {files.length === 0 ? (
          <p className="add-statements__empty muted">{t("review.addStatements.none")}</p>
        ) : (
          <ul className="form-group add-statements__list" aria-label={t("review.addStatements.new")}>
            {files.map((file) => {
              const name = fileName(file.path);
              const removeLabel = t("month.removeStatement", { name });
              return (
                <li key={file.id} className="statements__row">
                  <Icon name="doc" size={14} />
                  <span className="grow statements__name" title={file.path}>
                    {name}
                  </span>
                  {BANKS.length > 1 ? (
                    <PopUpButton
                      label={t("month.bankFor", { name })}
                      value={file.bank}
                      options={BANKS}
                      onChange={(bank) => onFiles(files.map((f) => (f.id === file.id ? { ...f, bank } : f)))}
                    />
                  ) : (
                    <span className="muted">{bankLabel(file.bank)}</span>
                  )}
                  <button
                    type="button"
                    className="icon"
                    aria-label={removeLabel}
                    title={removeLabel}
                    onClick={() => onFiles(files.filter((f) => f.id !== file.id))}
                  >
                    <Icon name="xmark" size={12} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {rejected !== null ? <SheetNote tone="warning">{t("month.notPdf", { name: rejected })}</SheetNote> : null}
    </Sheet>
  );
}
