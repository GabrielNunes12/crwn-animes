import styles from "./Skeleton.module.css";
import { useT } from "../../i18n/useT.js";

export function Skeleton({ className = "", style, ...rest }) {
  return <span className={`${styles.sk} ${className}`.trim()} style={style} aria-hidden="true" {...rest} />;
}

/** Card grid placeholder. kind: "video" (16:9) or "series" (2:3 poster). */
export function CardGridSkeleton({ count = 8, kind = "video", row = false }) {
  const { t } = useT();
  return (
    <div className={row ? "row-scroll" : kind === "video" ? "grid-videos" : "grid-cards"} role="status" aria-label={t("common.loading")}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={styles.card}>
          <Skeleton className={styles.media} style={{ aspectRatio: kind === "video" ? "16 / 9" : "2 / 3" }} />
          <Skeleton className={styles.line} style={{ inlineSize: "85%" }} />
          <Skeleton className={styles.line} style={{ inlineSize: "55%" }} />
        </div>
      ))}
    </div>
  );
}

export function PageSkeleton() {
  const { t } = useT();
  return (
    <div className="container" style={{ paddingBlock: "var(--space-6)" }} role="status" aria-label={t("common.loading")}>
      <Skeleton className={styles.title} />
      <Skeleton className={styles.line} style={{ inlineSize: "60%", marginBlockEnd: "var(--space-6)" }} />
      <CardGridSkeleton count={8} />
    </div>
  );
}
