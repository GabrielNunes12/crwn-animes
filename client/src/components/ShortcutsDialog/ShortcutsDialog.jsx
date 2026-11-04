import { useEffect, useRef } from "react";
import { useT } from "../../i18n/useT.js";
import { SingleKeyToggle } from "./SingleKeyToggle.jsx";
import { isApplePlatform } from "../../lib/platform.js";

const ROWS = [
  ["?", "shortcuts.help"],
  ["/", "shortcuts.search"],
  ["Shift + N", "shortcuts.next"],
  ["Shift + P", "shortcuts.prev"],
  ["T", "shortcuts.theatre"],
  ["Esc", "shortcuts.close"],
];

export function ShortcutsDialog({ open, onClose }) {
  const { t } = useT();
  const ref = useRef(null);
  const closeRef = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
      // Focus "Close" when the dialog opens. (React's autoFocus would call focus() when the
      // closed dialog mounts with the page, forcing a style recalculation before first paint.)
      closeRef.current?.focus();
    } else if (!open && d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
  }, [open]);

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="shortcuts-title" onClose={onClose}>
      <div className="stack">
        <h2 id="shortcuts-title" style={{ fontSize: "var(--step-1)" }}>
          {t("shortcuts.title")}
        </h2>
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.6rem 1rem", alignItems: "center" }}>
          {[[isApplePlatform() ? "⌘ K" : "Ctrl + K", "shortcuts.palette"], ...ROWS].map(([keys, label]) => (
            <div key={keys} style={{ display: "contents" }}>
              <dt>
                <kbd>{keys}</kbd>
              </dt>
              <dd style={{ margin: 0 }}>{t(label)}</dd>
            </div>
          ))}
        </dl>
        <p className="hint">{t("shortcuts.note")}</p>
        <SingleKeyToggle />
        <div className="cluster" style={{ justifyContent: "flex-end" }}>
          <button ref={closeRef} type="button" className="btn" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
