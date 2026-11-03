import { Link } from "react-router";
import { LazyImage } from "../LazyImage/LazyImage.jsx";
import { RatingBadge } from "./RatingBadge.jsx";
import { useT } from "../../i18n/useT.js";
import { sectionLabel, videoLabel } from "../../lib/format.js";
import { entryCompleted } from "../../lib/progress.js";
import styles from "./Cards.module.css";

export function VideoCard({ video, progress, showSeries = true }) {
  const { t } = useT();
  const label = videoLabel(t, video);
  const pct = progress?.d > 0 ? Math.min(100, Math.round((progress.t / progress.d) * 100)) : 0;
  const done = entryCompleted(progress);
  return (
    <article className={styles.card}>
      <Link to={video.route ?? "#"} className={styles.link}>
        <div className={styles.media}>
          <LazyImage src={video.thumbnailUrl} alt="" ratio="16 / 9" width={480} height={270} fallbackLabel={video.seriesName ?? video.title} />
          <div className={styles.badges}>
            {video.section && <span className={`badge badge-${video.section}`}>{sectionLabel(t, video.section)}</span>}
            {video.isNew && <span className="badge badge-new">{t("common.new")}</span>}
          </div>
          {done && (
            <span className={styles.watched}>
              <span aria-hidden="true">✓</span> {t("common.watched")}
            </span>
          )}
          {pct > 0 && !done && (
            <span className={styles.progress} style={{ "--p": `${pct}%` }} role="img" aria-label={t("series.progress", { percent: pct })} />
          )}
        </div>
        <div className={styles.body}>
          {showSeries && video.seriesName && <p className={styles.kicker}>{video.seriesName}</p>}
          <h3 className={styles.title}>{label}</h3>
          <p className={styles.sub} title={video.title}>{video.title}</p>
        </div>
      </Link>
      <div className={styles.meta}>
        <RatingBadge rating={video.rating} />
      </div>
    </article>
  );
}
