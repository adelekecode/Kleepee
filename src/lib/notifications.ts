/** Capability checks must never construct a notification or request permission. */
export function systemNotificationsSupported(): boolean {
  if (typeof window === "undefined" || window.isSecureContext === false) return false;
  if (typeof Notification === "undefined" || typeof Notification.requestPermission !== "function") return false;
  if (isIOS() && !isStandalone()) return false;
  return !isMobile() || typeof navigator.serviceWorker?.getRegistration === "function";
}

function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isMobile(): boolean {
  return isIOS() || /Android|Mobile/.test(navigator.userAgent);
}

function isStandalone(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function pageIsVisible(): boolean {
  return document.visibilityState === "visible";
}

/** Invoke directly from a click: do not await service worker readiness first. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!systemNotificationsSupported()) return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function getNotificationPermission(): NotificationPermission {
  return systemNotificationsSupported() ? Notification.permission : "denied";
}

/** Best effort for messages actually received while the page is running. No push delivery. */
export async function showMessageNotification(
  senderName: string,
  preview: string,
): Promise<boolean> {
  if (!systemNotificationsSupported() || Notification.permission !== "granted") return false;
  if (pageIsVisible()) return false;
  const title = `Message from ${senderName}`;
  const options: NotificationOptions = {
    body: preview.length > 100 ? preview.slice(0, 100) + "…" : preview,
    icon: "/icon-192.png",
    tag: "kleepee-message",
    // No session identifiers, join secrets, or message contents in notification data.
    data: { url: "/connected" },
    silent: !isSoundEnabled(),
  };
  try {
    // ready can wait forever in development when no worker is registered.
    const registration = await navigator.serviceWorker?.getRegistration();
    if (pageIsVisible()) return false;
    if (registration?.active && typeof registration.showNotification === "function") {
      await registration.showNotification(title, options);
      return true;
    }
    if (isMobile()) return false;
    const notification = new Notification(title, options);
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
    return true;
  } catch {
    return false;
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

  try {
    // Start the buffer inside the gesture, rather than after awaiting resume.
    playSilentBuffer(ctx);
    if (ctx.state !== "running") void ctx.resume().catch(() => {});
  } catch {
    // Audio restrictions must not interrupt the click handler or sharing.
  }
}

export function playMessageSound(): void {
  // Background playback/resume is controlled by the OS. Never queue a chime
  // behind a suspended resume promise, which could sound long after arrival.
  const ctx = audioCtx;
  if (!ctx || ctx.state !== "running" || document.visibilityState !== "visible") return;

  try {
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
  } catch {
    // Sound is optional; browser audio failures do not affect message delivery.
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
