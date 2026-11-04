import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { adminApi, catalogApi } from "../../api/client.js";
import { Tabs } from "../../components/Tabs/Tabs.jsx";
import { useTitle } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";
import { SeriesTab } from "./SeriesTab.jsx";
import { AddVideoTab } from "./AddVideoTab.jsx";
import { BulkTab } from "./BulkTab.jsx";
import { VideoListTab } from "./VideoListTab.jsx";
import { BrokenTab } from "./BrokenTab.jsx";
import { TrashTab } from "./TrashTab.jsx";
import { MetricsTab } from "./MetricsTab.jsx";
import { ErrorText } from "./shared.jsx";
import styles from "./Admin.module.css";

const TABS = ["series", "add", "bulk", "pending", "published", "broken", "trash", "metrics"];

export function Component() {
  const { t } = useT();
  const [params, setParams] = useSearchParams();
  const tab = TABS.includes(params.get("tab")) ? params.get("tab") : "series";
  const [series, setSeries] = useState([]);
  const [genres, setGenres] = useState([]);
  const [error, setError] = useState(null);
  useTitle(t("admin.title"));

  const [seriesVersion, setSeriesVersion] = useState(0);
  const reloadSeries = useCallback(() => setSeriesVersion((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    // Every series (all pages) for the series pickers; the Series tab pages its own list.
    adminApi
      .allSeries()
      .then((list) => {
        if (!alive) return;
        setSeries(list);
        setError(null);
      })
      .catch((err) => alive && setError(err));
    return () => {
      alive = false;
    };
  }, [seriesVersion]);

  useEffect(() => {
    catalogApi
      .genres()
      .then(setGenres)
      .catch(() => {});
  }, [seriesVersion]);

  return (
    <div className="container" style={{ paddingBlock: "var(--space-6)" }}>
      <header className={styles.head}>
        <h1>
          <span className="gradient-text">{t("admin.title")}</span>
        </h1>
        <p className="muted">{t("admin.subtitle")}</p>
      </header>
      <ErrorText error={error} />
      <Tabs
        label={t("admin.title")}
        tabs={TABS.map((id) => ({ id, label: t(`admin.tabs.${id}`) }))}
        active={tab}
        onChange={(id) => setParams({ tab: id }, { replace: true })}
      >
        {tab === "series" && <SeriesTab genres={genres} reloadSeries={reloadSeries} reloadKey={seriesVersion} />}
        {tab === "add" && <AddVideoTab series={series} />}
        {tab === "bulk" && <BulkTab series={series} />}
        {tab === "pending" && <VideoListTab key="pending" status="pending" series={series} />}
        {tab === "published" && <VideoListTab key="published" status="published" series={series} />}
        {tab === "broken" && <BrokenTab series={series} />}
        {tab === "trash" && <TrashTab reloadSeries={reloadSeries} />}
        {tab === "metrics" && <MetricsTab />}
      </Tabs>
    </div>
  );
}
