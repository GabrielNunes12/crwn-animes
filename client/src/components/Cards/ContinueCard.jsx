import { Link } from "react-router";
import { LazyImage } from "../LazyImage/LazyImage.jsx";
import { useT } from "../../i18n/useT.js";
import { formatTime } from "../../lib/progress.js";
import styles from "./Cards.module.css";

export function ContinueCard({ entry, onRemove }) {
  const { t } = useT();
  const pct = entry.d > 0 ? Math.min(100, Math.round((entry.t / entry.d) * 100)) : 0;
  const title = entry.title ?? entry.route;
  return (
    <article className={styles.card}>
      <Link to={entry.route} className={styles.link}>
        <div className={styles.media}>
          <LazyImage src={entry.thumb} alt="" ratio="16 / 9" fallbackLabel={title} />
          <span className={styles.progress} style={{ "--p": `${pct}%` }} role="img" aria-label={t("series.progress", { percent: pct })} />
        </div>
        <div className={styles.body}>
          <h3 className={styles.title} title={title}>{title}</h3>
          <p className={styles.sub}>{t("watch.resumeAt", { time: formatTime(entry.t) })}</p>
        </div>
      </Link>
      <button type="button" className={styles.remove} onClick={() => onRemove(entry.youtubeVideoId)} aria-label={t("home.removeContinue", { title })}>
        <span aria-hidden="true">×</span>
      </button>
    </article>
  );
}
