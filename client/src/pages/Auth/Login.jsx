import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { authApi } from "../../api/client.js";
import { useAuth } from "../../auth/useAuth.js";
import { TextField } from "../../components/Form/TextField.jsx";
import { PasswordField } from "../../components/Form/PasswordField.jsx";
import { useTitle } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";
import { safeNext } from "../../lib/validation.js";
import styles from "./Auth.module.css";

export function Component() {
  const { t, locale, errorMessage } = useT();
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [resend, setResend] = useState("idle"); // idle | sending | sent
  useTitle(t("auth.login.title"));

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResend("idle");
    try {
      await login(email.trim(), password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function onResend() {
    setResend("sending");
    try {
      await authApi.resendVerification(email.trim(), locale);
    } finally {
      setResend("sent");
    }
  }

  if (user && !busy) {
    return (
      <div className={`container ${styles.wrap}`}>
        <div className={styles.card}>
          <h1>{t("auth.login.already", { name: user.displayName })}</h1>
          <Link className="btn btn-primary" to={next}>
            {t("common.continue")}
          </Link>
        </div>
      </div>
    );
  }

  const notVerified = error?.code === "EMAIL_NOT_VERIFIED";

  return (
    <div className={`container ${styles.wrap}`}>
      <div className={styles.card}>
        <h1>{t("auth.login.title")}</h1>
        <p className="muted">{t("auth.login.subtitle")}</p>
        <form className={styles.form} onSubmit={onSubmit} noValidate={false}>
          <TextField label={t("auth.email")} type="email" value={email} onChange={setEmail} autoComplete="email" required inputMode="email" />
          <PasswordField label={t("auth.password")} value={password} onChange={setPassword} />
          <div className={styles.row}>
            <Link to="/forgot-password">{t("auth.login.forgot")}</Link>
          </div>
          <div aria-live="assertive" role="alert">
            {error && (
              <div className="alert alert-error stack" style={{ "--stack-gap": "var(--space-2)" }}>
                <p>{notVerified ? t("auth.login.notVerified") : errorMessage(error)}</p>
                {notVerified && (
                  <div>
                    <button type="button" className="btn btn-sm" onClick={onResend} disabled={resend !== "idle" || !email}>
                      {resend === "sending" ? t("common.working") : t("auth.resend")}
                    </button>
                    {resend === "sent" && <p className="hint" style={{ marginBlockStart: "var(--space-2)" }}>{t("auth.resent")}</p>}
                  </div>
                )}
              </div>
            )}
          </div>
          <button type="submit" className={`btn btn-primary ${styles.submit}`} disabled={busy}>
            {busy ? t("common.working") : t("auth.login.submit")}
          </button>
        </form>
        <p className={styles.alt}>
          {t("auth.login.noAccount")} <Link to="/register">{t("auth.login.createAccount")}</Link>
        </p>
      </div>
    </div>
  );
}
