import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { authApi } from "../../api/client.js";
import { TextField } from "../../components/Form/TextField.jsx";
import { PasswordField } from "../../components/Form/PasswordField.jsx";
import { useTitle } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";
import { MIN_PASSWORD } from "../../lib/password.js";
import { validateRegistration } from "../../lib/validation.js";
import styles from "./Auth.module.css";

export function Component() {
  const { t, locale, errorMessage } = useT();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: "", displayName: "", password: "", consent: false });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [busy, setBusy] = useState(false);
  useTitle(t("auth.register.title"));

  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));

  async function onSubmit(e) {
    e.preventDefault();
    const found = validateRegistration(form);
    setErrors(found);
    setServerError(null);
    if (Object.keys(found).length) {
      const first = Object.keys(found)[0];
      e.currentTarget.querySelector(`[data-field="${first}"] input`)?.focus();
      return;
    }
    setBusy(true);
    try {
      const email = form.email.trim();
      await authApi.register({ email, password: form.password, displayName: form.displayName.trim(), locale });
      navigate(`/check-email?email=${encodeURIComponent(email)}`, { state: { email } });
    } catch (err) {
      setServerError(err);
      if (err.details && typeof err.details === "object") {
        const fieldErrors = {};
        for (const k of ["email", "displayName", "password"]) if (err.details[k]) fieldErrors[k] = String(err.details[k]);
        if (Object.keys(fieldErrors).length) setErrors(fieldErrors);
      }
      setBusy(false);
    }
  }

  const err = (k) => (errors[k] ? (errors[k].startsWith("auth.") ? t(errors[k], { min: MIN_PASSWORD }) : errors[k]) : undefined);
  const errorCount = Object.keys(errors).length;

  return (
    <div className={`container ${styles.wrap}`}>
      <div className={styles.card}>
        <h1>{t("auth.register.title")}</h1>
        <p className="muted">{t("auth.register.subtitle")}</p>
        <form className={styles.form} onSubmit={onSubmit} noValidate>
          <p role="alert" aria-live="assertive" className={errorCount ? "alert alert-error" : "visually-hidden"}>
            {errorCount ? t("auth.errors.summary", { count: errorCount }) : ""}
          </p>
          {serverError && !errorCount && (
            <p className="alert alert-error" role="alert">
              {errorMessage(serverError)}
            </p>
          )}
          <div data-field="email">
            <TextField label={t("auth.email")} type="email" value={form.email} onChange={set("email")} error={err("email")} autoComplete="email" inputMode="email" required />
          </div>
          <div data-field="displayName">
            <TextField
              label={t("auth.displayName")}
              value={form.displayName}
              onChange={set("displayName")}
              error={err("displayName")}
              hint={t("auth.register.displayNameHint")}
              autoComplete="nickname"
              maxLength={30}
              required
            />
          </div>
          <div data-field="password">
            <PasswordField
              label={t("auth.password")}
              value={form.password}
              onChange={set("password")}
              error={err("password")}
              showStrength
              autoComplete="new-password"
              hint={t("auth.register.passwordHint", { min: MIN_PASSWORD })}
            />
          </div>
          <div data-field="consent" className="field">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.consent}
                onChange={(e) => set("consent")(e.target.checked)}
                aria-invalid={errors.consent ? "true" : undefined}
                aria-describedby={errors.consent ? "consent-err" : undefined}
                required
              />
              <span>
                {t("auth.register.consentBefore")}{" "}
                <Link to="/privacy" target="_blank">
                  {t("auth.register.consentLink")}
                </Link>
                {t("auth.register.consentAfter")}
              </span>
            </label>
            {errors.consent && (
              <p id="consent-err" className="field-error">
                {err("consent")}
              </p>
            )}
          </div>
          <button type="submit" className={`btn btn-primary ${styles.submit}`} disabled={busy}>
            {busy ? t("common.working") : t("auth.register.submit")}
          </button>
        </form>
        <p className={styles.alt}>
          {t("auth.register.haveAccount")} <Link to="/login">{t("auth.login.submit")}</Link>
        </p>
      </div>
    </div>
  );
}
