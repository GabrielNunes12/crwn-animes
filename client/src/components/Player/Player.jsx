import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useT } from "../../i18n/useT.js";
import { ALWAYS_LOAD_KEY, getBool, setBool } from "../../lib/prefs.js";
import { formatTime, getProgress, resumePosition, saveProgress } from "../../lib/progress.js";
import { loadYouTubeApi, UNPLAYABLE_ERRORS, YT_HOST, youtubeWatchUrl } from "../../lib/youtube.js";
import styles from "./Player.module.css";

const SAVE_EVERY_MS = 10_000;

/**
 * YouTube player behind a thumbnail facade. The IFrame API script is only
 * requested after the user presses play (or opted into "Always load").
 * Mount with key={video.youtubeVideoId}.
 */
export function Player({ video, autoStart = false, onEnded, next, nextLabel }) {
  const { t } = useT();
  const id = video.youtubeVideoId;
  const [alwaysLoad, setAlwaysLoad] = useState(() => getBool(ALWAYS_LOAD_KEY));
  const knownUnavailable = video.availability === "unavailable";
  const [activated, setActivated] = useState(() => !knownUnavailable && (autoStart || getBool(ALWAYS_LOAD_KEY)));
  const [wantsPlay, setWantsPlay] = useState(autoStart);
  const [phase, setPhase] = useState(knownUnavailable ? "unplayable" : "idle"); // idle | loading | ready | error | unplayable
  const [attempt, setAttempt] = useState(0);
  const [resumeAt] = useState(() => resumePosition(getProgress(id)));
  const mountRef = useRef(null);
  const stageRef = useRef(null);
  const focusOnReady = useRef(false); // the user pressed play: keep keyboard focus with the player
  const onEndedRef = useRef(onEnded);
  useEffect(() => {
    onEndedRef.current = onEnded;
  });

  useEffect(() => {
    if (!activated) return undefined;
    let cancelled = false;
    let player = null;
    let timer = null;
    const meta = { route: video.route, title: [video.seriesName, video.title].filter(Boolean).join(" — "), thumb: video.thumbnailUrl };
    const mount = mountRef.current;

    const save = (ended = false) => {
      try {
        if (!player?.getCurrentTime) return;
        const position = player.getCurrentTime();
        const duration = player.getDuration();
        if (!(duration > 0)) return;
        saveProgress(id, { position, duration, ended, ...meta });
      } catch {
        /* player already gone */
      }
    };
    const stopTimer = () => {
      clearInterval(timer);
      timer = null;
    };

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !mount) return;
        const host = document.createElement("div");
        mount.replaceChildren(host);
        player = new YT.Player(host, {
          host: YT_HOST,
          videoId: id,
          width: "100%",
          height: "100%",
          playerVars: {
            autoplay: wantsPlay ? 1 : 0,
            start: resumeAt || undefined,
            rel: 0,
            playsinline: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: (e) => {
              if (cancelled) return;
              try {
                const iframe = e.target.getIframe();
                iframe.title = video.title;
                // Move focus into the player before the facade button unmounts.
                if (focusOnReady.current) iframe.focus();
              } catch {
                /* ignore */
              }
              focusOnReady.current = false;
              setPhase("ready");
            },
            onStateChange: (e) => {
              const S = YT.PlayerState;
              if (e.data === S.PLAYING) {
                if (!timer) timer = setInterval(() => save(), SAVE_EVERY_MS);
              } else {
                stopTimer();
              }
              if (e.data === S.PAUSED) save();
              if (e.data === S.ENDED) {
                save(true);
                onEndedRef.current?.();
              }
            },
            onError: (e) => {
              if (cancelled) return;
              stopTimer();
              if (focusOnReady.current) stageRef.current?.focus();
              focusOnReady.current = false;
              setPhase(UNPLAYABLE_ERRORS.has(Number(e.data)) ? "unplayable" : "error");
            },
          },
        });
      })
      .catch(() => {
        if (cancelled) return;
        if (focusOnReady.current) stageRef.current?.focus();
        focusOnReady.current = false;
        setPhase("error");
      });

    const onPageHide = () => save();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") save();
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      save();
      stopTimer();
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      try {
        player?.destroy?.();
      } catch {
        /* ignore */
      }
      mount?.replaceChildren();
    };
    // `video` metadata is stable for a given key; `wantsPlay`/`resumeAt` are read at activation only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activated, id, attempt]);

  function play() {
    if (activated) return; // aria-disabled while loading: keep focus, ignore repeats
    focusOnReady.current = true;
    setWantsPlay(true);
    setActivated(true);
  }

  function toggleAlways(e) {
    setAlwaysLoad(e.target.checked);
    setBool(ALWAYS_LOAD_KEY, e.target.checked);
  }

  const showFacade = phase !== "unplayable" && (!activated || phase === "loading" || phase === "idle");

  return (
    <div className={styles.wrap}>
      <div ref={stageRef} className={styles.stage} data-phase={phase} tabIndex={-1} aria-busy={activated && phase === "idle" ? true : undefined}>
        <div ref={mountRef} className={styles.mount} hidden={phase === "unplayable" || phase === "error"} />

        {showFacade && (
          <button type="button" className={styles.facade} onClick={play} aria-disabled={activated || undefined} aria-label={t("watch.play", { title: video.title })}>
            <img src={video.thumbnailUrl} alt="" width="480" height="360" decoding="async" fetchPriority="high" />
            <span className={styles.playIcon} aria-hidden="true">
              {activated ? <span className={styles.spinner} /> : <svg viewBox="0 0 24 24" width="36" height="36"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>}
            </span>
            {resumeAt > 0 && !activated && <span className={styles.resume}>{t("watch.resumeAt", { time: formatTime(resumeAt) })}</span>}
            {activated && <span className="visually-hidden">{t("watch.loadingPlayer")}</span>}
          </button>
        )}

        {(phase === "unplayable" || phase === "error") && (
          <div className={styles.problem} role="alert">
            <h2>{phase === "unplayable" ? t("watch.cantPlay") : t("watch.playerFailed")}</h2>
            <p className="muted">{phase === "unplayable" ? t("watch.cantPlayText") : t("watch.playerFailedText")}</p>
            <div className="cluster">
              {phase === "error" && (
                <button type="button" className="btn" onClick={() => setAttempt((a) => a + 1)}>
                  {t("common.retry")}
                </button>
              )}
              {next?.route && (
                <Link className="btn btn-primary" to={next.route}>
                  {nextLabel ?? t("watch.next")}
                </Link>
              )}
              <a className="btn" href={youtubeWatchUrl(id)} target="_blank" rel="noopener noreferrer">
                {t("watch.watchOnYouTube")}
                <span className="visually-hidden"> ({t("common.newTab")})</span>
              </a>
            </div>
          </div>
        )}
      </div>

      <div className={styles.note}>
        <p className="hint">
          <span aria-hidden="true">ⓘ </span>
          {t("watch.playNote")}
        </p>
        <label className={styles.toggle}>
          <input type="checkbox" role="switch" checked={alwaysLoad} onChange={toggleAlways} />
          <span>{t("watch.alwaysLoad")}</span>
        </label>
      </div>
    </div>
  );
}
