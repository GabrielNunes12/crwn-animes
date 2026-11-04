import { useId, useState } from "react";
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
import { clearProgress, EXPORT_FILENAME, exportProgress, importProgress, MAX_IMPORT_BYTES } from "../../lib/progress.js";
import { clearRuntimeCaches } from "../../pwa/serviceWorker.js";
import { SingleKeyToggle } from "../../components/ShortcutsDialog/SingleKeyToggle.jsx";
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
  const { t, locale } = useT();
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
      const { user } = await meApi.changePassword(current, next, locale);
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

function downloadJSON(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function readFileText(file) {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

const IMPORT_ERRORS = { tooLarge: "account.progress.tooLarge", invalid: "account.progress.invalid", storage: "account.progress.storage" };

function DeviceCard() {
  const { t } = useT();
  const id = useId();
  const progress = useProgressMap();
  const count = Object.keys(progress).length;
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState({ message: "", error: false });
  const [busy, setBusy] = useState(false);

  function onExport() {
    downloadJSON(EXPORT_FILENAME, exportProgress());
    setStatus({ message: t("account.progress.exported", { count }), error: false });
  }

  async function onImport(e) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setBusy(true);
    let result;
    if (file.size > MAX_IMPORT_BYTES) {
      result = { ok: false, error: "tooLarge" };
    } else {
      try {
        result = importProgress(await readFileText(file), { size: file.size });
      } catch {
        result = { ok: false, error: "invalid" };
      }
    }
    // Let the same file be picked again.
    input.value = "";
    setBusy(false);
    setStatus(
      result.ok
        ? { message: t("account.progress.imported", { imported: result.imported, skipped: result.skipped }), error: false }
        : { message: t(IMPORT_ERRORS[result.error] ?? "account.progress.invalid"), error: true },
    );
  }

  return (
    <section className="card stack" aria-labelledby="device-title">
      <h2 id="device-title">{t("account.device")}</h2>
      <p className="hint">{t("account.deviceText")}</p>
      <h3 id={`${id}-progress`} className={styles.subTitle}>
        {t("account.progress.title")}
      </h3>
      <p>{t("account.historyCount", { count })}</p>
      <p className="hint">{t("account.progress.text")}</p>
      <div className="cluster">
        <button type="button" className="btn" onClick={onExport} disabled={!count}>
          <span aria-hidden="true">⤓</span> {t("account.progress.export")}
        </button>
        <label className={`btn ${styles.fileBtn}`} data-busy={busy || undefined}>
          <span aria-hidden="true">⤒</span> <span id={`${id}-import`}>{t("account.progress.import")}</span>
          <input
            type="file"
            accept="application/json,.json"
            className="visually-hidden"
            onChange={onImport}
            disabled={busy}
            aria-labelledby={`${id}-import`}
            aria-describedby={`${id}-import-hint`}
          />
        </label>
        <button type="button" className="btn" onClick={() => setOpen(true)} disabled={!count}>
          {t("account.clearHistory")}
        </button>
      </div>
      <p id={`${id}-import-hint`} className="hint">
        {t("account.progress.importHint")}
      </p>
      <p role="status" aria-live="polite" className={status.error ? "field-error" : styles.ok}>
        {status.message}
      </p>
      <hr />
      <SingleKeyToggle />
      <ConfirmDialog
        open={open}
        title={t("account.clearHistory")}
        confirmLabel={t("account.clearConfirm")}
        onConfirm={() => {
          clearProgress();
          clearRuntimeCaches(); // the offline copy of pages and images opened (docs/API.md v1.5)
          setOpen(false);
          setStatus({ message: t("account.historyCleared"), error: false });
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
