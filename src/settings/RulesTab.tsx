import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { Sheet, SheetNote } from "../components/Sheet";
import { useLatest } from "../lib/hooks/useLatest";
import { getRules, saveRules, type Rule } from "../lib/tauri";

/** A rule being added (no index) or edited. */
interface Editing {
  index: number | null;
  receiptVendor: string;
  transactionDescription: string;
  /** Return was pressed while a keyword was missing. */
  attempted: boolean;
}

/** A removed rule and the row it came from. */
interface Removed {
  rule: Rule;
  index: number;
}

function newId(): string {
  return crypto.randomUUID();
}

/**
 * Match rules: a table with add, edit and remove buttons; each change saves at once. A removal
 * can be undone from the banner or from Edit › Undo (`registerUndo`).
 */
export function RulesTab({
  onError,
  readOnly,
  registerUndo,
}: {
  onError: (e: unknown) => void;
  readOnly: boolean;
  registerUndo: RefObject<(() => void) | null>;
}) {
  const { t } = useTranslation();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [removed, setRemoved] = useState<Removed[]>([]);
  const table = useRef<HTMLTableElement>(null);
  /** The row that takes focus once the rules have rendered. */
  const focusRow = useRef<number | null>(null);

  const load = useCallback(() => {
    setLoadFailed(false);
    getRules().then(setRules, (e) => {
      setLoadFailed(true);
      onError(e);
    });
  }, [onError]);

  useEffect(load, [load]);

  useEffect(() => {
    const index = focusRow.current;
    if (index !== null) {
      focusRow.current = null;
      table.current?.querySelector<HTMLElement>(`tbody tr[data-index="${index}"]`)?.focus();
    }
  }, [rules]);

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
    if (readOnly || saving || !rules || index === null || index >= rules.length) {
      return;
    }
    const rule = rules[index];
    store(rules.filter((_, i) => i !== index)).then((saved) => {
      if (saved) {
        const next = Math.min(index, rules.length - 2);
        setRemoved((stack) => [...stack, { rule, index }]);
        setSelected(next < 0 ? null : next);
        focusRow.current = next < 0 ? null : next;
      }
    });
  }

  function undoRemove() {
    const last = removed[removed.length - 1];
    if (readOnly || saving || !rules || !last) {
      return;
    }
    const at = Math.min(last.index, rules.length);
    const next = [...rules.slice(0, at), last.rule, ...rules.slice(at)];
    store(next).then((saved) => {
      if (saved) {
        setRemoved((stack) => stack.slice(0, -1));
        setSelected(at);
        focusRow.current = at;
      }
    });
  }

  const latestUndo = useLatest(undoRemove);
  useEffect(() => {
    registerUndo.current = () => latestUndo.current();
    return () => {
      registerUndo.current = null;
    };
  }, [registerUndo, latestUndo]);

  function startEdit(index: number | null) {
    if (readOnly || !rules) {
      return;
    }
    const rule = index === null ? null : rules[index];
    setEditing({
      index,
      receiptVendor: rule?.receiptVendor ?? "",
      transactionDescription: rule?.transactionDescription ?? "",
      attempted: false,
    });
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
        setRemoved([]);
        setEditing(null);
      }
    });
  }

  function onRowKeyDown(e: KeyboardEvent<HTMLTableRowElement>, index: number) {
    const count = rules?.length ?? 0;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        const target = Math.min(count - 1, Math.max(0, index + (e.key === "ArrowDown" ? 1 : -1)));
        setSelected(target);
        table.current?.querySelector<HTMLElement>(`tbody tr[data-index="${target}"]`)?.focus();
        break;
      }
      case "Home":
      case "End": {
        e.preventDefault();
        const target = e.key === "Home" ? 0 : count - 1;
        setSelected(target);
        table.current?.querySelector<HTMLElement>(`tbody tr[data-index="${target}"]`)?.focus();
        break;
      }
      case "Enter":
        e.preventDefault();
        startEdit(index);
        break;
      case "Backspace":
      case "Delete":
        e.preventDefault();
        removeAt(index);
        break;
      default:
        break;
    }
  }

  if (!rules) {
    return loadFailed ? (
      <button type="button" style={{ alignSelf: "flex-start" }} onClick={load}>
        {t("common.tryAgain")}
      </button>
    ) : null;
  }

  const incomplete = editing !== null && (!editing.receiptVendor.trim() || !editing.transactionDescription.trim());
  const rowTabbable = selected !== null && selected < rules.length ? selected : 0;

  return (
    <section className="rules" aria-label={t("settings.rules.title")}>
      <p className="muted" style={{ margin: 0 }}>
        {t("settings.rules.description")}
      </p>
      <div className="rules__scroll">
        <table className="rules__table" role="grid" aria-label={t("settings.rules.title")} ref={table}>
          <thead>
            <tr>
              <th scope="col" role="columnheader">
                {t("settings.rules.receipt")}
              </th>
              <th scope="col" role="columnheader">
                {t("settings.rules.transaction")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 ? (
              <tr>
                <td className="rules__empty" role="gridcell" colSpan={2}>
                  {t("settings.rules.none")}
                </td>
              </tr>
            ) : (
              rules.map((rule, index) => (
                <tr
                  key={rule.id || index}
                  data-index={index}
                  className={index === selected ? "rules__row--selected" : undefined}
                  aria-selected={index === selected}
                  tabIndex={index === rowTabbable ? 0 : -1}
                  onFocus={() => setSelected(index)}
                  onClick={() => setSelected(index)}
                  onDoubleClick={() => startEdit(index)}
                  onKeyDown={(e) => onRowKeyDown(e, index)}
                >
                  <td role="gridcell">{rule.receiptVendor}</td>
                  <td role="gridcell">{rule.transactionDescription}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="rules__buttons">
        <div className="add-remove">
          <button
            type="button"
            aria-label={t("settings.rules.addRule")}
            title={t("settings.rules.addRule")}
            disabled={saving || readOnly}
            onClick={() => startEdit(null)}
          >
            <Icon name="plus" size={12} />
          </button>
          <button
            type="button"
            aria-label={t("settings.rules.deleteRule")}
            title={t("settings.rules.deleteRule")}
            disabled={saving || readOnly || selected === null}
            onClick={() => removeAt(selected)}
          >
            <Icon name="minus" size={12} />
          </button>
        </div>
        <button
          type="button"
          title={t("settings.rules.editRuleTitle")}
          disabled={saving || readOnly || selected === null}
          onClick={() => startEdit(selected)}
        >
          {t("settings.rules.editRule")}
        </button>
      </div>
      {removed.length > 0 ? (
        <div className="banner banner--info" role="status">
          <span className="grow">{t("settings.rules.removed")}</span>
          <button type="button" className="banner__action" disabled={saving || readOnly} onClick={undoRemove}>
            {t("settings.rules.undoRemove")}
          </button>
        </div>
      ) : null}
      {editing ? (
        <Sheet
          title={editing.index === null ? t("settings.rules.addRuleTitle") : t("settings.rules.editRuleTitle")}
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
              onKeyDown={(e) => e.key === "Enter" && incomplete && setEditing({ ...editing, attempted: true })}
            />
          </label>
          <label className="sheet__field">
            {t("settings.rules.transaction")}
            <input
              className="field"
              value={editing.transactionDescription}
              placeholder={t("settings.rules.transactionPlaceholder")}
              onChange={(e) => setEditing({ ...editing, transactionDescription: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && incomplete && setEditing({ ...editing, attempted: true })}
            />
          </label>
          {incomplete && editing.attempted ? <SheetNote tone="warning">{t("settings.rules.incomplete")}</SheetNote> : null}
        </Sheet>
      ) : null}
    </section>
  );
}
