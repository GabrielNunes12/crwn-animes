// Loads the YouTube IFrame Player API on demand (only after the user presses
// play or opted into "always load"). Players use the youtube-nocookie.com host.
export const YT_HOST = "https://www.youtube-nocookie.com";
const API_SRC = "https://www.youtube.com/iframe_api";
/** Player error codes that mean "this video can't be played here". */
export const UNPLAYABLE_ERRORS = new Set([2, 5, 100, 101, 150]);

let apiPromise = null;

export function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT);
    };
    const script = document.createElement("script");
    script.src = API_SRC;
    script.async = true;
    script.onerror = () => {
      apiPromise = null;
      script.remove();
      reject(new Error("YouTube player failed to load"));
    };
    document.head.append(script);
  });
  return apiPromise;
}

export function youtubeWatchUrl(id) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
}
