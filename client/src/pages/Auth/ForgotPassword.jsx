import { useState } from "react";
import { Link } from "react-router";
import { authApi } from "../../api/client.js";
import { TextField } from "../../components/Form/TextField.jsx";
import { useTitle } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";
import styles from "./Auth.module.css";

export function Component() {
  const { t, locale, errorMessage } = useT();
  const [email, setEmail] = useState("");
  const [state, setState] = useState({ status: "idle", error: null });
  useTitle(t("auth.forgot.title"));

  async function onSubmit(e) {
    e.preventDefault();
    setState({ status: "sending", error: null });
    try {
      await authApi.forgotPassword(email.trim(), locale);
      setState({ status: "sent", error: null });
    } catch (err) {
      setState({ status: "idle", error: err });
    }
  }

  return (
    <div className={`container ${styles.wrap}`}>
      <div className={styles.card}>
        <h1>{t("auth.forgot.title")}</h1>
        <p className="muted">{t("auth.forgot.text")}</p>
        {state.status === "sent" ? (
          <p className="alert alert-success" role="status">
            {t("auth.forgot.sent")}
          </p>
        ) : (
          <form className={styles.form} onSubmit={onSubmit}>
            <TextField label={t("auth.email")} type="email" value={email} onChange={setEmail} required autoComplete="email" />
            {state.error && (
              <p className="alert alert-error" role="alert">
                {errorMessage(state.error)}
              </p>
            )}
            <button type="submit" className={`btn btn-primary ${styles.submit}`} disabled={state.status === "sending"}>
              {state.status === "sending" ? t("common.working") : t("auth.forgot.submit")}
            </button>
          </form>
        )}
        <p className={styles.alt}>
          <Link to="/login">{t("auth.login.submit")}</Link>
        </p>
      </div>
    </div>
  );
}
