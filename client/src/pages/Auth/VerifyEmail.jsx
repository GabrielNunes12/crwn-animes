import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { authApi } from "../../api/client.js";
import { useAuth } from "../../auth/useAuth.js";
import { PasswordField } from "../../components/Form/PasswordField.jsx";
import { TextField } from "../../components/Form/TextField.jsx";
import { useTitle } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";
import styles from "./Auth.module.css";

/** "Link expired / already used" → ask for the email and resend a fresh link. */
function ResendForm() {
  const { t, locale, errorMessage } = useT();
  const [email, setEmail] = useState("");
  const [state, setState] = useState({ status: "idle", error: null });
  async function onSubmit(e) {
    e.preventDefault();
    setState({ status: "sending", error: null });
    try {
      await authApi.resendVerification(email.trim(), locale);
      setState({ status: "sent", error: null });
    } catch (err) {
      setState({ status: "idle", error: err });
    }
  }
  if (state.status === "sent") {
    return (
      <p className="alert alert-success" role="status">
        {t("auth.resent")}
      </p>
    );
  }
  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <TextField label={t("auth.email")} type="email" value={email} onChange={setEmail} required autoComplete="email" />
      {state.error && (
        <p className="alert alert-error" role="alert">
          {errorMessage(state.error)}
        </p>
      )}
      <button type="submit" className="btn" disabled={state.status === "sending" || !email.trim()}>
        {state.status === "sending" ? t("common.working") : t("auth.resend")}
      </button>
    </form>
  );
}

/**
 * /verify-email?token=… — the visitor confirms with the password chosen at
 * sign-up (POST { token, password }). Nothing is sent until they submit.
 */
export function Component() {
  const { t, errorMessage } = useT();
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useTitle(t("auth.verify.title"));

  async function onSubmit(e) {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      const { user } = await authApi.verifyEmail(token, password);
      setUser(user);
      navigate("/", { replace: true, state: { notice: "verified" } });
    } catch (err) {
      setError(err);
      setBusy(false);
      if (err.code === "INVALID_CREDENTIALS") setPassword("");
    }
  }

  const tokenDead = error?.code === "INVALID_TOKEN";
  const wrongPassword = error?.code === "INVALID_CREDENTIALS";

  return (
    <div className={`container ${styles.wrap}`}>
      <div className={styles.card}>
        <h1>{t("auth.verify.title")}</h1>
        {!token ? (
          <>
            <p className="alert alert-error" role="alert">
              {t("auth.verify.missing")}
            </p>
            <ResendForm />
          </>
        ) : tokenDead ? (
          <>
            <p className="alert alert-error" role="alert">
              {t("auth.verify.invalid")}
            </p>
            <p className="muted">{t("auth.verify.resendText")}</p>
            <ResendForm />
          </>
        ) : (
          <form className={styles.form} onSubmit={onSubmit}>
            <p className="muted">{t("auth.verify.text")}</p>
            <PasswordField label={t("auth.password")} value={password} onChange={setPassword} autoComplete="current-password" error={wrongPassword ? t("auth.verify.wrongPassword") : undefined} />
            <div role="alert" aria-live="assertive">
              {error && !wrongPassword && <p className="alert alert-error">{errorMessage(error)}</p>}
            </div>
            <button type="submit" className={`btn btn-primary ${styles.submit}`} disabled={busy || !password}>
              {busy ? t("auth.verify.working") : t("auth.verify.submit")}
            </button>
            <p className={styles.alt}>
              <Link to="/forgot-password">{t("auth.login.forgot")}</Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
