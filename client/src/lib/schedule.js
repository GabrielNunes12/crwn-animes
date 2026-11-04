/**
 * Runs `fn` once the browser has painted the current frame (a task queued from
 * requestAnimationFrame runs after that frame's rendering). Used to start below-the-fold work
 * only after a page's largest paint is on screen (docs/API.md v1.7). Returns a cancel function.
 */
export function afterNextPaint(fn) {
  let timer = null;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
  const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;
  const frame = raf(() => {
    timer = setTimeout(fn, 0);
  });
  return () => {
    caf(frame);
    clearTimeout(timer);
  };
}
