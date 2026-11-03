import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/useT.js";
import styles from "./Player.module.css";

const AUTO_NEXT_SECONDS = 10;

/** "Up next in 10 s" countdown with Cancel / Play now. Calls onPlay at 0. */
export function AutoNext({ title, seconds = AUTO_NEXT_SECONDS, onPlay, onCancel }) {
  const { t } = useT();
  const [left, setLeft] = useState(seconds);
  const onPlayRef = useRef(onPlay);
  const playNowRef = useRef(null);
  useEffect(() => {
    onPlayRef.current = onPlay;
  });

  useEffect(() => {
    playNowRef.current?.focus({ preventScroll: true });
    const timer = setInterval(() => setLeft((s) => s - 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (left <= 0) onPlayRef.current?.();
  }, [left]);

  return (
    <div className={styles.autoNext} role="region" aria-label={t("watch.upNext")}>
      <p aria-live="polite" className="visually-hidden">
        {t("watch.autoNextAnnounce", { seconds, title })}
      </p>
      <div className={styles.countdown} aria-hidden="true" style={{ "--progress": `${((seconds - Math.max(left, 0)) / seconds) * 100}%` }}>
        <span>{Math.max(left, 0)}</span>
      </div>
      <div className={styles.autoNextText}>
        <p className="hint">{t("watch.upNext")}</p>
        <p className={styles.autoNextTitle}>{title}</p>
      </div>
      <div className="cluster">
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button ref={playNowRef} type="button" className="btn btn-primary btn-sm" onClick={() => onPlay()}>
          {t("watch.playNow")}
        </button>
      </div>
    </div>
  );
}
