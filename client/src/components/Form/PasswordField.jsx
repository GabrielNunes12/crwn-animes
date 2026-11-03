import { useId, useState } from "react";
import { useT } from "../../i18n/useT.js";
import { passwordStrength } from "../../lib/password.js";
import styles from "./Form.module.css";

export function PasswordField({ label, name = "password", value, onChange, error, showStrength = false, autoComplete = "current-password", hint, required = true }) {
  const { t } = useT();
  const id = useId();
  const [visible, setVisible] = useState(false);
  const strength = showStrength ? passwordStrength(value) : null;
  const describedBy = [hint || showStrength ? `${id}-hint` : null, error ? `${id}-err` : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className={styles.pwWrap}>
        <input
          id={id}
          name={name}
          className="input"
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          required={required}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy}
        />
        <button type="button" className={styles.reveal} onClick={() => setVisible((v) => !v)} aria-pressed={visible} aria-label={visible ? t("auth.hidePassword") : t("auth.showPassword")}>
          {visible ? t("auth.hide") : t("auth.show")}
        </button>
      </div>
      {(hint || showStrength) && (
        <div id={`${id}-hint`} className={styles.pwHint}>
          {showStrength && (
            <span className={styles.meter} data-score={strength.score} aria-hidden="true">
              {[1, 2, 3, 4].map((i) => (
                <span key={i} />
              ))}
            </span>
          )}
          <span className="hint">
            {hint}
            {showStrength && value ? ` · ${t("password.strengthLabel", { value: t(strength.key) })}` : ""}
          </span>
        </div>
      )}
      {error && (
        <p id={`${id}-err`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}
