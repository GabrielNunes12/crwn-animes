import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { authApi } from "../../api/client.js";
import { useAuth } from "../../auth/useAuth.js";
import { PasswordField } from "../../components/Form/PasswordField.jsx";
import { useTitle } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";
import { MIN_PASSWORD } from "../../lib/password.js";
import styles from "./Auth.module.css";

export function Component() {
  const { t, locale, errorMessage } = useT();
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [busy, setBusy] = useState(false);
  useTitle(t("auth.reset.title"));

  async function onSubmit(e) {
    e.preventDefault();
    const found = {};
    if (password.length < MIN_PASSWORD) found.password = t("auth.errors.passwordLength", { min: MIN_PASSWORD });
    if (confirm !== password) found.confirm = t("auth.errors.mismatch");
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    setServerError(null);
    try {
      const { user } = await authApi.resetPassword(token, password, locale);
      setUser(user);
      navigate("/", { replace: true, state: { notice: "passwordReset" } });
    } catch (err) {
      setServerError(err);
      setBusy(false);
    }
  }

  return (
    <div className={`container ${styles.wrap}`}>
      <div className={styles.card}>
        <h1>{t("auth.reset.title")}</h1>
        {!token ? (
          <>
            <p className="alert alert-error" role="alert">
              {t("auth.reset.missing")}
            </p>
            <Link className="btn" to="/forgot-password">
              {t("auth.reset.requestNew")}
            </Link>
          </>
        ) : (
          <form className={styles.form} onSubmit={onSubmit} noValidate>
            <PasswordField label={t("auth.newPassword")} value={password} onChange={setPassword} error={errors.password} showStrength autoComplete="new-password" hint={t("auth.register.passwordHint", { min: MIN_PASSWORD })} />
            <PasswordField label={t("auth.confirmPassword")} value={confirm} onChange={setConfirm} error={errors.confirm} autoComplete="new-password" />
            <div role="alert" aria-live="assertive">
              {serverError && (
                <div className="alert alert-error">
                  <p>{serverError.code === "INVALID_TOKEN" ? t("auth.reset.invalid") : errorMessage(serverError)}</p>
                  {serverError.code === "INVALID_TOKEN" && <Link to="/forgot-password">{t("auth.reset.requestNew")}</Link>}
                </div>
              )}
            </div>
            <button type="submit" className={`btn btn-primary ${styles.submit}`} disabled={busy}>
              {busy ? t("common.working") : t("auth.reset.submit")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
