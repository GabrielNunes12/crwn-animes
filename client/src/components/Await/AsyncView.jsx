import { Suspense } from "react";
import { Await, Link, useAsyncError } from "react-router";
import { useT } from "../../i18n/useT.js";

function AsyncError() {
  const error = useAsyncError();
  return <ErrorNotice error={error} />;
}

export function ErrorNotice({ error }) {
  const { t, errorMessage } = useT();
  if (error?.status === 404) {
    return (
      <div className="container" style={{ paddingBlock: "var(--space-7)" }}>
        <div className="card stack" style={{ maxInlineSize: "36rem" }}>
          <h1>{t("notFound.title")}</h1>
          <p className="muted">{t("notFound.text")}</p>
          <Link className="btn btn-primary" to="/" style={{ justifySelf: "start" }}>
            {t("notFound.home")}
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="alert alert-error" role="alert">
      <p>{errorMessage(error)}</p>
      <button type="button" className="btn btn-sm" style={{ marginBlockStart: "var(--space-2)" }} onClick={() => window.location.reload()}>
        {t("common.retry")}
      </button>
    </div>
  );
}

/** <AsyncView resolve={promise} fallback={<Skeleton/>}>{(data) => …}</AsyncView> */
export function AsyncView({ resolve, fallback, children, errorElement }) {
  return (
    <Suspense fallback={fallback}>
      <Await resolve={resolve} errorElement={errorElement ?? <AsyncError />}>
        {children}
      </Await>
    </Suspense>
  );
}
