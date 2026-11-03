import { useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { authApi } from "../../api/client.js";
import { TextField } from "../../components/Form/TextField.jsx";
import { useTitle } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";
import styles from "./Auth.module.css";

export function Component() {
  const { t, locale, errorMessage } = useT();
  const location = useLocation();
  const [params] = useSearchParams();
  const initial = location.state?.email ?? params.get("email") ?? "";
  const [email, setEmail] = useState(initial);
  const [state, setState] = useState({ status: "idle", error: null });
  useTitle(t("auth.checkEmail.title"));

  async function resend(e) {
    e.preventDefault();
    setState({ status: "sending", error: null });
    try {
      await authApi.resendVerification(email.trim(), locale);
      setState({ status: "sent", error: null });
    } catch (err) {
      setState({ status: "idle", error: err });
    }
  }

  return (
    <div className={`container ${styles.wrap}`}>
      <div className={styles.card}>
        <p style={{ fontSize: "2.5rem" }} aria-hidden="true">
          ✉️
        </p>
        <h1>{t("auth.checkEmail.title")}</h1>
        <p>{initial ? t("auth.checkEmail.text", { email: initial }) : t("auth.checkEmail.textNoEmail")}</p>
        <p className="hint">{t("auth.checkEmail.spam")}</p>
        <form className={styles.form} onSubmit={resend}>
          {!initial && <TextField label={t("auth.email")} type="email" value={email} onChange={setEmail} required autoComplete="email" />}
          <button type="submit" className="btn" disabled={state.status === "sending" || !email}>
            {state.status === "sending" ? t("common.working") : t("auth.resend")}
          </button>
          <p role="status" aria-live="polite" className={state.status === "sent" ? "alert alert-success" : state.error ? "alert alert-error" : "visually-hidden"}>
            {state.status === "sent" ? t("auth.resent") : state.error ? errorMessage(state.error) : ""}
          </p>
        </form>
        <p className={styles.alt}>
          <Link to="/login">{t("auth.login.submit")}</Link>
        </p>
      </div>
    </div>
  );
}
