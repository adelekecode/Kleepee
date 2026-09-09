/**
 * An inactivity deadline, not a wall-clock expiry. Hidden/frozen pages may stop
 * executing JavaScript altogether. Give queued network events a fresh grace
 * period when execution resumes instead of expiring them immediately.
 */
export function backgroundTimeout(
  callback: () => void,
  delay: number,
  isPeerPaused: () => boolean = () => false,
): () => void {
  let timer: ReturnType<typeof setTimeout>;
  let cancelled = false;
  let frozen = false;
  let scheduledAt = Date.now();
  const documentTarget = typeof document === "undefined" ? null : document;
  const windowTarget = typeof window === "undefined" ? null : window;
  const schedule = () => {
    if (cancelled) return;
    clearTimeout(timer);
    scheduledAt = Date.now();
    timer = setTimeout(check, delay);
  };
  const cancel = () => {
    cancelled = true;
    clearTimeout(timer);
    documentTarget?.removeEventListener("visibilitychange", schedule);
    documentTarget?.removeEventListener("freeze", freeze);
    documentTarget?.removeEventListener("resume", resume);
    windowTarget?.removeEventListener("pageshow", resume);
  };
  const check = () => {
    if (cancelled) return;
    const delayedBySuspension = Date.now() - scheduledAt > delay + 1000;
    if (
      frozen ||
      documentTarget?.visibilityState === "hidden" ||
      isPeerPaused() ||
      delayedBySuspension
    ) {
      schedule();
      return;
    }
    cancel();
    callback();
  };
  const freeze = () => {
    frozen = true;
  };
  const resume = () => {
    frozen = false;
    schedule();
  };
  documentTarget?.addEventListener("visibilitychange", schedule);
  documentTarget?.addEventListener("freeze", freeze);
  documentTarget?.addEventListener("resume", resume);
  windowTarget?.addEventListener("pageshow", resume);
  schedule();
  return cancel;
}
