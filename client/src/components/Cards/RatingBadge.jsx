import { useT } from "../../i18n/useT.js";
import styles from "./Cards.module.css";

export function RatingBadge({ rating }) {
  const { t, formatNumber } = useT();
  if (!rating || !rating.count) return <span className={styles.rating}>{t("common.noRatings")}</span>;
  return (
    <span className={styles.rating} title={t("rating.averageLong", { avg: formatNumber(rating.average), count: rating.count })}>
      <span aria-hidden="true" className={styles.star}>★</span>
      <span className="visually-hidden">{t("rating.averageLong", { avg: formatNumber(rating.average), count: rating.count })}</span>
      <span aria-hidden="true">
        {formatNumber(rating.average)} <span className="muted">({formatNumber(rating.count)})</span>
      </span>
    </span>
  );
}
