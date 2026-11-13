import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { Sheet, SheetNote } from "../components/Sheet";
import { newReasonId, OTHER_REASON, reasonLabel, reasonName } from "../lib/reasons";
import { getRules, saveReasons, showAlert, type AppStateView, type Reason } from "../lib/tauri";

/** A reason being added (no index) or edited. */
interface Editing {
  index: number | null;
  en: string;
  pt: string;
  /** Return was pressed while the names were not valid. */
  attempted: boolean;
}

/** A row being dragged to a new place. */
interface Drag {
  from: number;
  startY: number;
  /** The gap the row drops into: 0 is above the first row, the row count is below the last one. */
  to: number | null;
}

/** How far the pointer moves before a press on a row becomes a drag, in pixels. */
const DRAG_THRESHOLD = 4;

/** The list with the reason at `from` moved into the gap `to`, the gaps counted as in `Drag`. */
export function moveReason(reasons: readonly Reason[], from: number, to: number): Reason[] {
  const next = [...reasons];
  const [moved] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, moved);
  return next;
}

/** Why the names in the sheet cannot be saved, or null when they can. */
function namesProblem(editing: Editing, reasons: readonly Reason[]): "empty" | "duplicate" | null {
  const en = editing.en.trim();
  const pt = editing.pt.trim();
  if (!en && !pt) {
    return "empty";
  }
  const shown = (names: { en: string; pt: string }) => [(names.en || names.pt).toLowerCase(), (names.pt || names.en).toLowerCase()];
  const [newEn, newPt] = shown({ en, pt });
  const clash = reasons.some((reason, i) => {
    if (i === editing.index) {
      return false;
    }
    const [oldEn, oldPt] = shown({ en: reason.names.en.trim(), pt: reason.names.pt.trim() });
    return oldEn === newEn || oldPt === newPt;
  });
  return clash ? "duplicate" : null;
}

/**
 * The no-receipt reasons: a table of each reason's English and Portuguese names, in menu order,
 * with add, edit and remove buttons. Drag a row, or press ⌥↑ or ⌥↓, to move it. Removing a reason
 * asks first; rules and transactions that use it then show as Other, which cannot be removed.
 * Each change saves at once.
 */
export function ReasonsTab({
  state,
  replace,
  onError,
}: {
  state: AppStateView;
  replace: (view: AppStateView) => void;
  onError: (e: unknown) => void;
}) {
  const { t, i18n } = useTranslation();
  const fieldId = useId();
  const reasons = state.reasons;
  const readOnly = state.read_only;
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const table = useRef<HTMLTableElement>(null);
  /** The row that takes focus once the reasons have rendered. */
  const focusRow = useRef<number | null>(null);

  useEffect(() => {
    const index = focusRow.current;
    if (index !== null) {
      focusRow.current = null;
      table.current?.querySelector<HTMLElement>(`tbody tr[data-index="${index}"]`)?.focus();
    }
  }, [reasons]);

  /** Saves the reasons. Resolves to whether they were saved. */
  function store(next: Reason[]): Promise<boolean> {
    setSaving(true);
    return saveReasons(next)
      .then(
        (view) => {
          replace(view);
          return true;
        },
        (e) => {
          onError(e);
          return false;
        },
      )
      .finally(() => setSaving(false));
  }

  function canRemove(index: number | null): index is number {
    return !readOnly && !saving && index !== null && index < reasons.length && reasons[index].id !== OTHER_REASON;
  }

  /** Asks in a native alert, then removes the reason. The alert counts the rules that use it. */
  function askRemove(index: number | null) {
    if (!canRemove(index)) {
      return;
    }
    const reason = reasons[index];
    getRules()
      .then((rules) => {
        const count = rules.filter((rule) => rule.noReceipt === reason.id).length;
        const other = reasonLabel(reasons, OTHER_REASON, i18n.language);
        return showAlert({
          title: t("settings.reasons.removeTitle", { name: reasonName(reason, i18n.language) }),
          message: count > 0 ? t("settings.reasons.removeMessageRules", { count, other }) : t("settings.reasons.removeMessage", { other }),
          confirm: t("settings.reasons.removeConfirm"),
          cancel: t("common.cancel"),
        });
      })
      .then((choice) => {
        if (choice !== "confirm") {
          return;
        }
        return store(reasons.filter((_, i) => i !== index)).then((saved) => {
          if (saved) {
            const next = Math.min(index, reasons.length - 2);
            setSelected(next);
            focusRow.current = next;
          }
        });
      })
      .catch(onError);
  }

  function move(from: number, to: number) {
    if (readOnly || saving || to < 0 || to > reasons.length || to === from || to === from + 1) {
      return;
    }
    const at = to > from ? to - 1 : to;
    store(moveReason(reasons, from, to)).then((saved) => {
      if (saved) {
        setSelected(at);
        focusRow.current = at;
      }
    });
  }

  function startEdit(index: number | null) {
    if (readOnly) {
      return;
    }
    const reason = index === null ? null : reasons[index];
    setEditing({ index, en: reason?.names.en ?? "", pt: reason?.names.pt ?? "", attempted: false });
  }

  function submitEdit() {
    if (!editing) {
      return;
    }
    const names = { en: editing.en.trim(), pt: editing.pt.trim() };
    const next =
      editing.index === null
        ? [...reasons.filter((r) => r.id !== OTHER_REASON), { id: newReasonId(), names }, ...reasons.filter((r) => r.id === OTHER_REASON)]
        : reasons.map((r, i) => (i === editing.index ? { ...r, names } : r));
    store(next).then((saved) => {
      if (saved) {
        setEditing(null);
      }
    });
  }

  function onRowKeyDown(e: KeyboardEvent<HTMLTableRowElement>, index: number) {
    const count = reasons.length;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        const down = e.key === "ArrowDown";
        if (e.altKey) {
          move(index, down ? index + 2 : index - 1);
          break;
        }
        const target = Math.min(count - 1, Math.max(0, index + (down ? 1 : -1)));
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
        askRemove(index);
        break;
      default:
        break;
    }
  }

  /** The gap under the pointer: the number of rows whose middle is above it. */
  function gapAt(clientY: number): number {
    const rows = table.current?.querySelectorAll<HTMLElement>("tbody tr[data-index]") ?? [];
    return Array.from(rows).filter((row) => {
      const box = row.getBoundingClientRect();
      return box.top + box.height / 2 < clientY;
    }).length;
  }

  function onPointerDown(e: PointerEvent<HTMLTableRowElement>, index: number) {
    if (e.button !== 0 || readOnly || saving) {
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ from: index, startY: e.clientY, to: null });
  }

  function onPointerMove(e: PointerEvent<HTMLTableRowElement>) {
    if (!drag) {
      return;
    }
    if (drag.to === null && Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD) {
      return;
    }
    const to = gapAt(e.clientY);
    if (to !== drag.to) {
      setDrag({ ...drag, to });
    }
  }

  function onPointerUp() {
    if (drag?.to != null) {
      move(drag.from, drag.to);
    }
    setDrag(null);
  }

  const problem = editing ? namesProblem(editing, reasons) : null;
  const rowTabbable = selected !== null && selected < reasons.length ? selected : 0;
  const dropGap = drag?.to ?? null;
  const otherSelected = selected !== null && reasons[selected]?.id === OTHER_REASON;

  return (
    <section className="rules" aria-label={t("settings.reasons.title")}>
      <p className="muted" style={{ margin: 0 }}>
        {t("settings.reasons.description")}
      </p>
      <div className="rules__scroll">
        <table className="rules__table reasons__table" role="grid" aria-label={t("settings.reasons.title")} ref={table}>
          <thead>
            <tr>
              <th scope="col" role="columnheader">
                {t("settings.reasons.english")}
              </th>
              <th scope="col" role="columnheader">
                {t("settings.reasons.portuguese")}
              </th>
            </tr>
          </thead>
          <tbody>
            {reasons.map((reason, index) => {
              const classes = [
                index === selected ? "rules__row--selected" : "",
                dropGap === index ? "reasons__row--drop-above" : "",
                dropGap === reasons.length && index === reasons.length - 1 ? "reasons__row--drop-below" : "",
                drag?.to != null && drag.from === index ? "reasons__row--dragged" : "",
              ].filter(Boolean);
              return (
                <tr
                  key={reason.id}
                  data-index={index}
                  className={classes.join(" ") || undefined}
                  aria-selected={index === selected}
                  tabIndex={index === rowTabbable ? 0 : -1}
                  onFocus={() => setSelected(index)}
                  onClick={() => setSelected(index)}
                  onDoubleClick={() => startEdit(index)}
                  onKeyDown={(e) => onRowKeyDown(e, index)}
                  onPointerDown={(e) => onPointerDown(e, index)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={() => setDrag(null)}
                >
                  <td role="gridcell" className={reason.names.en ? undefined : "reasons__fallback"}>
                    {reason.names.en || reason.names.pt}
                  </td>
                  <td role="gridcell" className={reason.names.pt ? undefined : "reasons__fallback"}>
                    {reason.names.pt || reason.names.en}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="rules__buttons">
        <div className="add-remove">
          <button
            type="button"
            aria-label={t("settings.reasons.add")}
            title={t("settings.reasons.add")}
            disabled={saving || readOnly}
            onClick={() => startEdit(null)}
          >
            <Icon name="plus" size={12} />
          </button>
          <button
            type="button"
            aria-label={t("settings.reasons.remove")}
            title={otherSelected ? t("settings.reasons.otherKept") : t("settings.reasons.remove")}
            disabled={!canRemove(selected)}
            onClick={() => askRemove(selected)}
          >
            <Icon name="minus" size={12} />
          </button>
        </div>
        <button type="button" title={t("settings.reasons.editTitle")} disabled={saving || readOnly || selected === null} onClick={() => startEdit(selected)}>
          {t("settings.reasons.edit")}
        </button>
      </div>
      {editing ? (
        <Sheet
          title={editing.index === null ? t("settings.reasons.addTitle") : t("settings.reasons.editTitle")}
          submitLabel={editing.index === null ? t("common.add") : t("common.save")}
          submitDisabled={problem !== null}
          busy={saving}
          onCancel={() => setEditing(null)}
          onSubmit={submitEdit}
        >
          <div className="sheet__grid">
            <label htmlFor={`${fieldId}-en`}>{t("settings.reasons.nameEn")}</label>
            <input
              id={`${fieldId}-en`}
              className="field"
              value={editing.en}
              placeholder={t("settings.reasons.namePlaceholderEn")}
              onChange={(e) => setEditing({ ...editing, en: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && problem && setEditing({ ...editing, attempted: true })}
            />
            <label htmlFor={`${fieldId}-pt`}>{t("settings.reasons.namePt")}</label>
            <input
              id={`${fieldId}-pt`}
              className="field"
              value={editing.pt}
              placeholder={t("settings.reasons.namePlaceholderPt")}
              onChange={(e) => setEditing({ ...editing, pt: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && problem && setEditing({ ...editing, attempted: true })}
            />
          </div>
          <p className="muted" style={{ margin: 0 }}>
            {t("settings.reasons.fallback")}
          </p>
          {problem === "duplicate" ? <SheetNote tone="warning">{t("settings.reasons.duplicate")}</SheetNote> : null}
          {problem === "empty" && editing.attempted ? <SheetNote tone="warning">{t("settings.reasons.empty")}</SheetNote> : null}
        </Sheet>
      ) : null}
    </section>
  );
}
