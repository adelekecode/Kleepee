// ---------------------------------------------------------------------------
// System notification support detection
// ---------------------------------------------------------------------------

/**
 * Returns true only when the browser actually supports and can show system
 * notifications. Mobile Chrome (non-PWA) does not support the Notification
 * constructor in a regular tab, so we probe for it explicitly.
 */
export function systemNotificationsSupported(): boolean {
  if (typeof window === "undefined") return false;
  if (!("Notification" in window)) return false;

  // Mobile Chrome reports Notification in window but silently fails unless
  // the site is installed as a PWA. We detect this by checking for the
  // serviceWorker + PushManager combo that the push-based path requires.
  // If neither is available we treat system notifications as unsupported.
  try {
    // A quick sanity-check: can we actually construct one (won't fire without
    // permission, but won't throw on supported platforms either)?
    // On Android Chrome in a tab this throws "Illegal constructor".
    new Notification(""); // will be blocked by permission anyway
    return true;
  } catch {
    return false;
  }
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!systemNotificationsSupported()) return "denied";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  return Notification.requestPermission();
}

export function getNotificationPermission(): NotificationPermission {
  if (!systemNotificationsSupported()) return "denied";
  return Notification.permission;
}

/** Show a system notification only when the tab is not focused. */
export function showMessageNotification(senderName: string, preview: string): void {
  if (!systemNotificationsSupported()) return;
  if (Notification.permission !== "granted") return;
  if (document.visibilityState === "visible") return;

  try {
    new Notification(`Message from ${senderName}`, {
      body: preview.length > 100 ? preview.slice(0, 100) + "…" : preview,
      icon: "/favicon-32x32.png",
      tag: "kleepee-message",
    } as NotificationOptions);
  } catch {
    /* silently ignore on platforms where construction fails */
  }
}

// ---------------------------------------------------------------------------
// Audio — Web Audio API chime, unlocked by first user gesture
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null;

function getOrCreateContext(): AudioContext | null {
  try {
    if (!audioCtx || audioCtx.state === "closed") {
      audioCtx = new AudioContext();
    }
    return audioCtx;
  } catch {
    return null;
  }
}

function playSilentBuffer(ctx: AudioContext): void {
  // Playing a real (silent) buffer is the only reliable way to unlock
  // AudioContext on iOS Safari and Android Chrome. A plain ctx.resume()
  // is not enough — a buffer source must actually be started.
  const buffer = ctx.createBuffer(1, 1, 22050);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(0);
}

/**
 * Call this inside a direct user-gesture handler (tap, click, keydown).
 * Creates and unlocks the AudioContext so sounds can play later.
 */
export function unlockAudio(): void {
  const ctx = getOrCreateContext();
  if (!ctx) return;

  const doUnlock = () => {
    playSilentBuffer(ctx);
  };

  if (ctx.state === "suspended") {
    void ctx.resume().then(doUnlock);
  } else {
    doUnlock();
  }
}

export function playMessageSound(): void {
  const ctx = getOrCreateContext();
  if (!ctx) return;

  const play = () => {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(660, now + 0.12);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
  };

  if (ctx.state === "suspended") {
    // Context suspended — try to resume. On iOS this only works if called
    // from within a gesture; otherwise it's a no-op and sound is skipped.
    void ctx.resume().then(play);
  } else {
    play();
  }
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export function isSoundEnabled(): boolean {
  try {
    const stored = localStorage.getItem("kleepee.notifications.sound");
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

export function setSoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem("kleepee.notifications.sound", String(enabled));
  } catch {
    /* ignore */
  }
}
