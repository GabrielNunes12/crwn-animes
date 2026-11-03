import { useEffect, useId, useRef } from "react";
import { useT } from "../../i18n/useT.js";

/**
 * Native <dialog> confirm. Controlled by `open`. Children render inside the form
 * (e.g. a password field). onConfirm receives the submit event.
 */
export function ConfirmDialog({ open, title, children, confirmLabel, danger = true, busy = false, onConfirm, onClose }) {
  const { t } = useT();
  const ref = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    } else if (!open && d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
  }, [open]);

  return (
    <dialog ref={ref} className="dialog" aria-labelledby={titleId} onClose={onClose} onCancel={onClose}>
      <form
        method="dialog"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm?.(e);
        }}
      >
        <h2 id={titleId} style={{ fontSize: "var(--step-1)" }}>
          {title}
        </h2>
        {children}
        <div className="cluster" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="submit" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} disabled={busy}>
            {busy ? t("common.working") : confirmLabel ?? t("common.delete")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
