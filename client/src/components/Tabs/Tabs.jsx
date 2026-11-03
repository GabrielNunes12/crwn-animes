import { useId, useRef } from "react";
import styles from "./Tabs.module.css";

/** WAI-ARIA tabs with arrow/Home/End keys. tabs = [{ id, label }]. */
export function Tabs({ tabs, active, onChange, label, children }) {
  const base = useId();
  const refs = useRef({});

  function onKeyDown(e) {
    const i = tabs.findIndex((t) => t.id === active);
    let next = null;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next == null) return;
    e.preventDefault();
    onChange(tabs[next].id);
    refs.current[tabs[next].id]?.focus();
  }

  return (
    <div>
      <div role="tablist" aria-label={label} className={styles.list} onKeyDown={onKeyDown}>
        {tabs.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={t.id === active}
            aria-controls={`${base}-panel`}
            tabIndex={t.id === active ? 0 : -1}
            className={styles.tab}
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {t.count != null && <span className={styles.count}>{t.count}</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${active}`} className={styles.panel} tabIndex={0}>
        {children}
      </div>
    </div>
  );
}
