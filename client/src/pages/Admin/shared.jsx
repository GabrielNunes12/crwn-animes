import { Link } from "react-router";
import { useT } from "../../i18n/useT.js";
import { videoLabel } from "../../lib/format.js";
import styles from "./Admin.module.css";

export function StatusBadge({ status, availability, trashed = false }) {
  const { t } = useT();
  return (
    <span className="cluster" style={{ "--cluster-gap": "0.3rem" }}>
      {trashed ? (
        <span className={`badge ${styles.trashed}`}>{t("admin.preview.trashed")}</span>
      ) : (
        <span className={`badge ${status === "published" ? styles.published : styles.pending}`}>{t(`admin.status.${status}`)}</span>
      )}
      {availability === "unavailable" && <span className="badge badge-warn">{t("common.unavailable")}</span>}
    </span>
  );
}

export function Reasons({ classification }) {
  const { t, formatNumber } = useT();
  if (!classification) return null;
  return (
    <div className={styles.reasons}>
      <p className="hint">
        {t("admin.scores", { anime: formatNumber(classification.scores?.anime ?? 0), manga: formatNumber(classification.scores?.manga ?? 0) })}
        {classification.suggestedNumber != null && <> · {t("admin.suggested", { n: classification.suggestedNumber })}</>}
      </p>
      {classification.reasons?.length > 0 && (
        <ul className={styles.reasonList}>
          {classification.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Compact summary of a video for result cards. */
export function VideoSummary({ video }) {
  const { t } = useT();
  return (
    <div className={styles.summary}>
      <img src={video.thumbnailUrl} alt="" width="160" height="90" loading="lazy" decoding="async" className={styles.thumb} />
      <div className="stack" style={{ "--stack-gap": "0.3rem", minInlineSize: 0 }}>
        <StatusBadge status={video.status} availability={video.availability} trashed={Boolean(video.deletedAt)} />
        <p className={styles.videoTitle}>{video.title}</p>
        <p className="hint">
          {[video.section && t(`common.${video.section}`), video.seriesName, video.number != null && videoLabel(t, video)].filter(Boolean).join(" · ") || t("admin.unclassified")}
        </p>
        {video.route && (
          <Link to={video.route}>
            {t("admin.open")} <code>{video.route}</code>
          </Link>
        )}
      </div>
    </div>
  );
}

export function SectionSelect({ id, value, onChange, allowAuto = true }) {
  const { t } = useT();
  return (
    <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      {allowAuto && <option value="">{t("admin.auto")}</option>}
      <option value="anime">{t("common.anime")}</option>
      <option value="manga">{t("common.manga")}</option>
    </select>
  );
}

export function SeriesSelect({ id, value, onChange, series }) {
  const { t } = useT();
  return (
    <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t("admin.auto")}</option>
      {series.map((s) => (
        <option key={s.id} value={s.slug}>
          {s.name}
        </option>
      ))}
    </select>
  );
}

export function ErrorText({ error }) {
  const { errorMessage } = useT();
  if (!error) return null;
  return (
    <p className="alert alert-error" role="alert">
      {errorMessage(error)}
    </p>
  );
}
