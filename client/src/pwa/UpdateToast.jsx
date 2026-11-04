import { useState, useSyncExternalStore } from "react";
import { useT } from "../i18n/useT.js";
import { applyUpdate, dismissUpdate, getWaitingRegistration, subscribeWaiting } from "./serviceWorker.js";
import styles from "./UpdateToast.module.css";

/**
 * "Nova versão disponível — Atualizar". The status paragraph is always in the DOM (empty until
 * a new service worker is waiting) so screen readers announce it when it fills in.
 * `apply` is injectable for tests.
 */
export function UpdateToast({ apply = applyUpdate }) {
  const { t } = useT();
  const registration = useSyncExternalStore(subscribeWaiting, getWaitingRegistration, () => null);
  const [updating, setUpdating] = useState(false);
  const open = Boolean(registration);

  return (
    <div className={styles.toast} data-open={open || undefined}>
      <p role="status" className={styles.text}>
        {open ? t("pwa.updateAvailable") : ""}
      </p>
      {open && (
        <div className={styles.actions}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={updating}
            onClick={() => {
              if (apply(registration)) setUpdating(true);
              else dismissUpdate();
            }}
          >
            {updating ? t("pwa.updating") : t("pwa.update")}
          </button>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={t("pwa.dismiss")} onClick={dismissUpdate}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
    </div>
  );
}
