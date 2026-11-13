import { useEffect, useRef, useState } from "react";
import { useFormDescription } from "./Form";

/**
 * A text field that saves when it loses focus or on Return, and puts the saved value back on
 * Escape. Its text follows `value` whenever the field is not being edited. With `suggestions` it
 * is a combo box: typing stays free and the system's suggestion list offers the values.
 */
export function TextSetting({
  id,
  label,
  value,
  placeholder,
  disabled,
  suggestions,
  onCommit,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  suggestions?: string[];
  onCommit: (value: string) => void;
}) {
  const describedBy = useFormDescription();
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!editing) {
      setDraft(value);
    }
  }, [value, editing]);

  function commit() {
    setEditing(false);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (draft.trim() !== value.trim()) {
      onCommit(draft.trim());
    }
  }

  const listId = suggestions ? `${id}-suggestions` : undefined;

  return (
    <>
      <input
        id={id}
        className="field"
        aria-label={label}
        aria-describedby={describedBy}
        list={listId}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            cancelled.current = true;
            setDraft(value);
            setEditing(false);
            e.currentTarget.blur();
            cancelled.current = false;
          }
        }}
      />
      {suggestions ? (
        <datalist id={listId}>
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      ) : null}
    </>
  );
}
