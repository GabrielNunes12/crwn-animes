import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { authApi, meApi } from "../../api/client.js";
import { useAuth } from "../../auth/useAuth.js";
import { ConfirmDialog } from "../../components/ConfirmDialog/ConfirmDialog.jsx";
import { TextField } from "../../components/Form/TextField.jsx";
import { PasswordField } from "../../components/Form/PasswordField.jsx";
import { PageSkeleton } from "../../components/Skeleton/Skeleton.jsx";
import { useProgressMap } from "../../hooks/useProgress.js";
import { useTitle } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";
import { MIN_PASSWORD } from "../../lib/password.js";
import { clearProgress } from "../../lib/progress.js";
import styles from "./Account.module.css";

function Status({ state }) {
  const { errorMessage } = useT();
  return (
    <p role="status" aria-live="polite" className={state.error ? "field-error" : styles.ok}>
      {state.error ? errorMessage(state.error) : state.message}
    </p>
  );
}

function ProfileCard() {
  const { t } = useT();
  const { user, setUser } = useAuth();
  const [name, setName] = useState(user.displayName);
  const [state, setState] = useState({ busy: false, message: "", error: null });

  async function onSubmit(e) {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 30) {
      setState({ busy: false, message: "", error: { message: t("auth.errors.displayName") } });
      return;
    }
    setState({ busy: true, message: "", error: null });
    try {
      const { user: updated } = await meApi.update(trimmed);
      setUser(updated);
      setState({ busy: false, message: t("account.nameSaved"), error: null });
    } catch (err) {
      setState({ busy: false, message: "", error: err });
    }
  }

  return (
    <section className="card stack" aria-labelledby="profile-title">
      <h2 id="profile-title">{t("account.profile")}</h2>
      <p className="muted">
        {t("auth.email")}: <strong>{user.email}</strong>
      </p>
      <form className="stack" onSubmit={onSubmit}>
        <TextField label={t("auth.displayName")} value={name} onChange={setName} maxLength={30} hint={t("auth.register.displayNameHint")} required />
        <div className="cluster">
          <button className="btn btn-primary" disabled={state.busy || name.trim() === user.displayName}>
            {state.busy ? t("common.saving") : t("account.saveName")}
          </button>
        </div>
        <Status state={state} />
      </form>
    </section>
  );
}

function PasswordCard() {
  const { t } = useT();
  const { setUser } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [state, setState] = useState({ busy: false, message: "", error: null });

  async function onSubmit(e) {
    e.preventDefault();
    if (next.length < MIN_PASSWORD) {
      setState({ busy: false, message: "", error: { message: t("auth.errors.passwordLength", { min: MIN_PASSWORD }) } });
      return;
    }
    setState({ busy: true, message: "", error: null });
    try {
      const { user } = await meApi.changePassword(current, next);
      setUser(user);
      setCurrent("");
      setNext("");
      setState({ busy: false, message: t("account.passwordChanged"), error: null });
    } catch (err) {
      setState({ busy: false, message: "", error: err });
    }
  }

  return (
    <section className="card stack" aria-labelledby="pw-title">
      <h2 id="pw-title">{t("account.password")}</h2>
      <p className="hint">{t("account.passwordText")}</p>
      <form className="stack" onSubmit={onSubmit}>
        <PasswordField label={t("account.currentPassword")} value={current} onChange={setCurrent} autoComplete="current-password" />
        <PasswordField label={t("auth.newPassword")} value={next} onChange={setNext} showStrength autoComplete="new-password" hint={t("auth.register.passwordHint", { min: MIN_PASSWORD })} />
        <div className="cluster">
          <button className="btn btn-primary" disabled={state.busy || !current || !next}>
            {state.busy ? t("common.saving") : t("account.changePassword")}
          </button>
        </div>
        <Status state={state} />
      </form>
    </section>
  );
}

function SessionsCard() {
  const { t, errorMessage } = useT();
  const { logout, setUser } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function everywhere() {
    setBusy(true);
    try {
      await authApi.logoutAll();
      setUser(null);
      navigate("/login", { replace: true, state: { notice: "signedOutEverywhere" } });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <section className="card stack" aria-labelledby="sessions-title">
      <h2 id="sessions-title">{t("account.sessions")}</h2>
      <p className="hint">{t("account.sessionsText")}</p>
      <div className="cluster">
        <button
          type="button"
          className="btn"
          onClick={async () => {
            await logout();
            navigate("/");
          }}
        >
          {t("nav.logout")}
        </button>
        <button type="button" className="btn" onClick={everywhere} disabled={busy}>
          {busy ? t("common.working") : t("account.signOutEverywhere")}
        </button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {errorMessage(error)}
        </p>
      )}
    </section>
  );
}

function DataCard() {
  const { t, errorMessage } = useT();
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [state, setState] = useState({ busy: false, error: null });

  async function onDelete() {
    if (!password) return;
    setState({ busy: true, error: null });
    try {
      await meApi.remove(password);
      setOpen(false);
      setUser(null);
      navigate("/", { replace: true, state: { notice: "accountDeleted" } });
    } catch (err) {
      setState({ busy: false, error: err });
    }
  }

  return (
    <section className="card stack" aria-labelledby="data-title">
      <h2 id="data-title">{t("account.data")}</h2>
      <p className="hint">{t("account.exportText")}</p>
      <div className="cluster">
        <a className="btn" href={meApi.exportUrl} download>
          <span aria-hidden="true">⤓</span> {t("account.export")}
        </a>
        <Link to="/privacy">{t("footer.privacy")}</Link>
      </div>
      <hr />
      <h3>{t("account.deleteTitle")}</h3>
      <p className="hint">{t("account.deleteText")}</p>
      <div>
        <button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>
          {t("account.deleteButton")}
        </button>
      </div>
      <ConfirmDialog
        open={open}
        title={t("account.deleteConfirmTitle")}
        confirmLabel={t("account.deleteButton")}
        busy={state.busy}
        onConfirm={onDelete}
        onClose={() => {
          setOpen(false);
          setPassword("");
          setState({ busy: false, error: null });
        }}
      >
        <p>{t("account.deleteConfirmText")}</p>
        <PasswordField label={t("account.passwordConfirm")} value={password} onChange={setPassword} autoComplete="current-password" />
        {state.error && (
          <p className="field-error" role="alert">
            {errorMessage(state.error)}
          </p>
        )}
      </ConfirmDialog>
    </section>
  );
}

function DeviceCard() {
  const { t } = useT();
  const progress = useProgressMap();
  const count = Object.keys(progress).length;
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <section className="card stack" aria-labelledby="device-title">
      <h2 id="device-title">{t("account.device")}</h2>
      <p className="hint">{t("account.deviceText")}</p>
      <p>{t("account.historyCount", { count })}</p>
      <div>
        <button type="button" className="btn" onClick={() => setOpen(true)} disabled={!count}>
          {t("account.clearHistory")}
        </button>
      </div>
      <p role="status" aria-live="polite" className={styles.ok}>
        {message}
      </p>
      <ConfirmDialog
        open={open}
        title={t("account.clearHistory")}
        confirmLabel={t("account.clearConfirm")}
        onConfirm={() => {
          clearProgress();
          setOpen(false);
          setMessage(t("account.historyCleared"));
        }}
        onClose={() => setOpen(false)}
      >
        <p>{t("account.clearHistoryText")}</p>
      </ConfirmDialog>
    </section>
  );
}

export function Component() {
  const { t } = useT();
  const { user, status } = useAuth();
  useTitle(t("account.title"));
  if (status === "loading") return <PageSkeleton />;

  return (
    <div className="container" style={{ paddingBlock: "var(--space-6)" }}>
      <h1 style={{ marginBlockEnd: "var(--space-5)" }}>{t("account.title")}</h1>
      <div className={styles.grid}>
        {user ? (
          <>
            <ProfileCard />
            <PasswordCard />
            <SessionsCard />
            <DataCard />
          </>
        ) : (
          <section className="card stack" aria-labelledby="guest-title">
            <h2 id="guest-title">{t("account.loggedOutTitle")}</h2>
            <p className="muted">{t("account.loggedOutText")}</p>
            <div className="cluster">
              <Link className="btn btn-primary" to="/login?next=%2Faccount">
                {t("nav.login")}
              </Link>
              <Link className="btn" to="/register">
                {t("nav.signup")}
              </Link>
            </div>
          </section>
        )}
        <DeviceCard />
      </div>
    </div>
  );
}
