import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { Sheet, SheetNote } from "../components/Sheet";
import { getRules, saveRules, type Rule } from "../lib/tauri";

/** A rule being added (no index) or edited. */
interface Editing {
  index: number | null;
  receiptVendor: string;
  transactionDescription: string;
}

function newId(): string {
  return crypto.randomUUID();
}

/** Match rules: a list with add and remove buttons; each change saves at once. */
export function RulesTab({ onError }: { onError: (e: unknown) => void }) {
  const { t } = useTranslation();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(() => {
    setLoadFailed(false);
    getRules().then(setRules, (e) => {
      setLoadFailed(true);
      onError(e);
    });
  }, [onError]);

  useEffect(load, [load]);

  /** Saves the rules. Resolves to whether they were saved. */
  function store(next: Rule[]): Promise<boolean> {
    setSaving(true);
    return saveRules(next)
      .then(
        (saved) => {
          setRules(saved);
          return true;
        },
        (e) => {
          onError(e);
          return false;
        },
      )
      .finally(() => setSaving(false));
  }

  function removeAt(index: number | null) {
    if (rules && index !== null) {
      store(rules.filter((_, i) => i !== index)).then((saved) => {
        if (saved) {
          setSelected(null);
        }
      });
    }
  }

  function submitEdit() {
    if (!rules || !editing) {
      return;
    }
    const rule: Rule = {
      id: editing.index === null ? newId() : rules[editing.index].id || newId(),
      receiptVendor: editing.receiptVendor.trim(),
      transactionDescription: editing.transactionDescription.trim(),
    };
    const next = editing.index === null ? [...rules, rule] : rules.map((r, i) => (i === editing.index ? rule : r));
    store(next).then((saved) => {
      if (saved) {
        setEditing(null);
      }
    });
  }

  if (!rules) {
    return loadFailed ? (
      <button type="button" style={{ alignSelf: "flex-start" }} onClick={load}>
        {t("common.tryAgain")}
      </button>
    ) : null;
  }

  const incomplete = editing !== null && (!editing.receiptVendor.trim() || !editing.transactionDescription.trim());
  const halfFilled = incomplete && (editing.receiptVendor.trim() !== "" || editing.transactionDescription.trim() !== "");

  return (
    <section className="rules" aria-label={t("settings.rules.title")}>
      <p className="muted" style={{ margin: 0 }}>
        {t("settings.rules.description")}
      </p>
      <table className="rules__table">
        <thead>
          <tr>
            <th scope="col">{t("settings.rules.receipt")}</th>
            <th scope="col">{t("settings.rules.transaction")}</th>
          </tr>
        </thead>
        <tbody>
          {rules.length === 0 ? (
            <tr>
              <td className="rules__empty" colSpan={2}>
                {t("settings.rules.none")}
              </td>
            </tr>
          ) : (
            rules.map((rule, index) => (
              <tr
                key={rule.id || index}
                className={index === selected ? "rules__row--selected" : undefined}
                aria-selected={index === selected}
                tabIndex={0}
                onClick={() => setSelected(index)}
                onDoubleClick={() => setEditing({ index, ...rule })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setEditing({ index, ...rule });
                  } else if (e.key === "Backspace" || e.key === "Delete") {
                    removeAt(index);
                  }
                }}
              >
                <td>{rule.receiptVendor}</td>
                <td>{rule.transactionDescription}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div className="add-remove">
        <button
          type="button"
          aria-label={t("settings.rules.addRule")}
          title={t("settings.rules.addRule")}
          disabled={saving}
          onClick={() => setEditing({ index: null, receiptVendor: "", transactionDescription: "" })}
        >
          <Icon name="plus" size={12} />
        </button>
        <button
          type="button"
          aria-label={t("settings.rules.deleteRule")}
          title={t("settings.rules.deleteRule")}
          disabled={saving || selected === null}
          onClick={() => removeAt(selected)}
        >
          <Icon name="minus" size={12} />
        </button>
      </div>
      {editing ? (
        <Sheet
          title={editing.index === null ? t("settings.rules.addRule") : t("settings.rules.editRule")}
          submitLabel={editing.index === null ? t("common.add") : t("common.save")}
          submitDisabled={incomplete}
          busy={saving}
          onCancel={() => setEditing(null)}
          onSubmit={submitEdit}
        >
          <label className="sheet__field">
            {t("settings.rules.receipt")}
            <input
              className="field"
              value={editing.receiptVendor}
              placeholder={t("settings.rules.receiptPlaceholder")}
              onChange={(e) => setEditing({ ...editing, receiptVendor: e.target.value })}
            />
          </label>
          <label className="sheet__field">
            {t("settings.rules.transaction")}
            <input
              className="field"
              value={editing.transactionDescription}
              placeholder={t("settings.rules.transactionPlaceholder")}
              onChange={(e) => setEditing({ ...editing, transactionDescription: e.target.value })}
            />
          </label>
          {halfFilled ? <SheetNote tone="warning">{t("settings.rules.incomplete")}</SheetNote> : null}
        </Sheet>
      ) : null}
    </section>
  );
}
