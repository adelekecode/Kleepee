/** Request browser notification permission. Returns the resulting permission state. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!("Notification" in window)) return "denied";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  return Notification.requestPermission();
}

export function getNotificationPermission(): NotificationPermission {
  if (!("Notification" in window)) return "denied";
  return Notification.permission;
}

/** Show a browser notification if permission is granted and the page is not visible. */
export function showMessageNotification(senderName: string, preview: string): void {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  // Don't notify when the tab is focused — the user can already see the message.
  if (document.visibilityState === "visible") return;

  new Notification(`Message from ${senderName}`, {
    body: preview.length > 100 ? preview.slice(0, 100) + "…" : preview,
    icon: "/favicon-32x32.png",
    tag: "kleepee-message",   // coalesce rapid messages into one notification
  } as NotificationOptions);
}

// ---------------------------------------------------------------------------
// Notification sound — generated entirely via Web Audio API, no asset files.
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  try {
    if (!audioCtx || audioCtx.state === "closed") {
      audioCtx = new AudioContext();
    }
    return audioCtx;
  } catch {
    return null;
  }
}

/**
 * Play a short, subtle "pop" chime using the Web Audio API.
 * Silent if audio context cannot be created (e.g. autoplay policy).
 */
export function playMessageSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  // Resume context if suspended (browser autoplay policy).
  const resume = ctx.state === "suspended" ? ctx.resume() : Promise.resolve();

  void resume.then(() => {
    const now = ctx.currentTime;

    // Sine oscillator for a clean tone
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, now);          // A5
    osc.frequency.exponentialRampToValueAtTime(660, now + 0.12); // ramp down to E5

    // Gain envelope: quick attack, smooth decay
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.01);  // attack
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35); // decay

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
  });
}

/** User preference: whether notification sound is enabled. Defaults to true. */
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
