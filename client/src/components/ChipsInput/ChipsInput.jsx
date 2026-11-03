import { useId, useState } from "react";
import { useT } from "../../i18n/useT.js";
import styles from "./ChipsInput.module.css";

/** Tag-style input: Enter or comma adds, Backspace on empty removes the last chip. */
export function ChipsInput({ label, value, onChange, suggestions = [], hint, placeholder }) {
  const { t } = useT();
  const id = useId();
  const [draft, setDraft] = useState("");

  function add(raw) {
    const items = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!items.length) return;
    const next = [...value];
    for (const item of items) if (!next.some((v) => v.toLowerCase() === item.toLowerCase())) next.push(item);
    onChange(next);
    setDraft("");
  }

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className={styles.box}>
        <ul className={styles.list} role="list" aria-label={label}>
          {value.map((v) => (
            <li key={v} className={styles.chip}>
              {v}
              <button type="button" className={styles.x} onClick={() => onChange(value.filter((x) => x !== v))} aria-label={t("common.removeItem", { item: v })}>
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
        <input
          id={id}
          className={styles.input}
          value={draft}
          placeholder={placeholder}
          list={suggestions.length ? `${id}-list` : undefined}
          aria-describedby={`${id}-hint`}
          onChange={(e) => {
            if (e.target.value.includes(",")) add(e.target.value);
            else setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => add(draft)}
        />
        {suggestions.length > 0 && (
          <datalist id={`${id}-list`}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
      </div>
      <p id={`${id}-hint`} className="hint">
        {hint ?? t("admin.chipsHint")}
      </p>
    </div>
  );
}
