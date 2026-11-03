import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { authApi } from "../../api/client.js";
import { useAuth } from "../../auth/useAuth.js";
import { useTitle } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";
import styles from "./Auth.module.css";

export function Component() {
  const { t, errorMessage } = useT();
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token");
  const [error, setError] = useState(null);
  const started = useRef(false); // tokens are single-use: never POST twice (StrictMode)
  useTitle(t("auth.verify.title"));

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    authApi
      .verifyEmail(token)
      .then(({ user }) => {
        setUser(user);
        navigate("/", { replace: true, state: { notice: "verified" } });
      })
      .catch(setError);
  }, [token, setUser, navigate]);

  return (
    <div className={`container ${styles.wrap}`}>
      <div className={styles.card} aria-live="polite">
        <h1>{t("auth.verify.title")}</h1>
        {!token ? (
          <p className="alert alert-error" role="alert">
            {t("auth.verify.missing")}
          </p>
        ) : error ? (
          <>
            <p className="alert alert-error" role="alert">
              {error.code === "INVALID_TOKEN" ? t("auth.verify.invalid") : errorMessage(error)}
            </p>
          </>
        ) : (
          <p role="status">{t("auth.verify.working")}</p>
        )}
        {(error || !token) && (
          <Link className="btn" to="/check-email">
            {t("auth.verify.requestNew")}
          </Link>
        )}
      </div>
    </div>
  );
}
