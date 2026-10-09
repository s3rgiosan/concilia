import { useEffect, useState } from "react";
import { useFormDescription } from "./Form";

/**
 * A text field that saves when it loses focus or on Return, and puts the saved value back on
 * Escape. Its text follows `value` whenever the field is not being edited.
 */
export function TextSetting({
  id,
  label,
  value,
  placeholder,
  disabled,
  onCommit,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onCommit: (value: string) => void;
}) {
  const describedBy = useFormDescription();
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) {
      setDraft(value);
    }
  }, [value, editing]);

  function commit() {
    setEditing(false);
    if (draft.trim() !== value.trim()) {
      onCommit(draft.trim());
    }
  }

  return (
    <input
      id={id}
      className="field"
      aria-label={label}
      aria-describedby={describedBy}
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
          setDraft(value);
          setEditing(false);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
