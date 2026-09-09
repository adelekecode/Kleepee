import { useEffect } from "react";

/** Best effort only: a screen wake lock cannot prevent background tab suspension. */
export function useTransferWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !navigator.wakeLock) return;

    let disposed = false;
    let generation = 0;
    let pending = false;
    let lock: WakeLockSentinel | null = null;
    const wanted = () => !disposed && document.visibilityState === "visible";
    const release = (sentinel: WakeLockSentinel) => {
      void sentinel.release().catch(() => {
        // The browser may already have released the lock.
      });
    };
    const releaseCurrent = () => {
      if (!lock) return;
      const previous = lock;
      lock = null;
      release(previous);
    };

    async function acquire() {
      if (!wanted() || pending || lock) return;
      pending = true;
      const requestedGeneration = generation;
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (!wanted() || requestedGeneration !== generation) {
          release(sentinel);
        } else if (!sentinel.released) {
          lock = sentinel;
          sentinel.addEventListener(
            "release",
            () => {
              if (lock === sentinel) lock = null;
            },
            { once: true },
          );
        }
      } catch {
        // Unsupported policies, low battery, and denial must not affect transfers.
      } finally {
        pending = false;
        // A visibility transition may have occurred while the request was pending.
        if (requestedGeneration !== generation && wanted()) void acquire();
      }
    }

    const onVisibilityChange = () => {
      generation += 1;
      if (wanted()) void acquire();
      else releaseCurrent();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void acquire();
    return () => {
      disposed = true;
      generation += 1;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      releaseCurrent();
    };
  }, [active]);
}
