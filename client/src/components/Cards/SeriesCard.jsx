import { Link } from "react-router";
import { LazyImage } from "../LazyImage/LazyImage.jsx";
import { RatingBadge } from "./RatingBadge.jsx";
import { useT } from "../../i18n/useT.js";
import { sectionLabel } from "../../lib/format.js";
import styles from "./Cards.module.css";

/** `showSection` adds an Anime/Mangá badge (search results mix both sections). */
export function SeriesCard({ series, section, showSection = false }) {
  const { t } = useT();
  const countKey = section === "manga" ? "common.chapters" : "common.episodes";
  return (
    <article className={`${styles.card} ${styles.series}`}>
      <Link to={series.route ?? `/${section}/${series.slug}`} className={styles.link}>
        <div className={styles.media}>
          <LazyImage src={series.coverUrl} alt="" ratio="2 / 3" width={300} height={450} fallbackLabel={series.name} />
          {showSection && (
            <div className={styles.badges}>
              <span className={`badge badge-${section}`}>{sectionLabel(t, section)}</span>
            </div>
          )}
        </div>
        <div className={styles.body}>
          <h3 className={styles.title}>{series.name}</h3>
          <p className={styles.sub}>{t(countKey, { count: series.videoCount ?? 0 })}</p>
          {series.genres?.length > 0 && (
            <ul className={styles.genres} role="list" aria-label={t("common.genres")}>
              {series.genres.slice(0, 3).map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          )}
        </div>
      </Link>
      <div className={styles.meta}>
        <RatingBadge rating={series.rating} />
      </div>
    </article>
  );
}
