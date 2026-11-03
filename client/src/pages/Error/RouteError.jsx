import { isRouteErrorResponse, Link, useRouteError } from "react-router";
import { useT } from "../../i18n/useT.js";
import { ErrorNotice } from "../../components/Await/AsyncView.jsx";

function ErrorCard() {
  const error = useRouteError();
  const { t } = useT();
  const status = isRouteErrorResponse(error) ? error.status : error?.status;
  if (status === 404) return <ErrorNotice error={{ status: 404 }} />;
  if (import.meta.env.DEV) console.error(error);
  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)" }}>
      <div className="card stack" role="alert" style={{ maxInlineSize: "38rem" }}>
        <h1>{t("error.title")}</h1>
        <p className="muted">{t("error.text")}</p>
        <div className="cluster">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            {t("error.reload")}
          </button>
          <Link to="/" className="btn">
            {t("notFound.home")}
          </Link>
        </div>
      </div>
    </div>
  );
}

/** Errors inside a page: rendered within the layout (header/footer stay). */
export function RouteError() {
  return <ErrorCard />;
}

/** Errors in the layout itself: bare page. */
export function RootError() {
  return (
    <main id="main" style={{ minBlockSize: "100dvh", display: "grid", placeItems: "center" }}>
      <ErrorCard />
    </main>
  );
}
