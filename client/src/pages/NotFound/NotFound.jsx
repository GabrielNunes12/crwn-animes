import { ErrorNotice } from "../../components/Await/AsyncView.jsx";
import { useT } from "../../i18n/useT.js";
import { useTitle } from "../../hooks/useTitle.js";

export function Component() {
  const { t } = useT();
  useTitle(t("notFound.title"), t("meta.notFound"));
  return <ErrorNotice error={{ status: 404 }} />;
}
