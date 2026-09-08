const STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

interface IceConfiguration {
  iceServers: RTCIceServer[];
  expiresAt: number;
}

function isIceServer(value: unknown): value is RTCIceServer {
  if (!value || typeof value !== "object") return false;
  const server = value as RTCIceServer;
  const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
  return Array.isArray(urls) && urls.length > 0 && urls.every((url) =>
    typeof url === "string" && /^(stun|turn|turns):/.test(url)
  ) && (!urls.some((url) => /^turns?:/.test(url)) || (
    typeof server.username === "string" && server.username.length > 0 &&
    typeof server.credential === "string" && server.credential.length > 0
  ));
}

// Keep short-lived credentials in memory and refresh them before a new
// negotiation. The session encryption secret is never sent to this endpoint.
export function createIceServerLoader(workerBase: string, sessionId: string, deviceId: string) {
  let cached: IceConfiguration | null = null;
  let pending: Promise<RTCIceServer[]> | null = null;

  async function load(): Promise<RTCIceServer[]> {
    const response = await fetch(
      `${workerBase}/sessions/${encodeURIComponent(sessionId)}/ice-servers?deviceId=${encodeURIComponent(deviceId)}`,
      { cache: "no-store", signal: AbortSignal.timeout(8_000) },
    );

    // Allow the frontend and Worker to be rolled out separately. An older
    // Worker has no credential route and can only support direct connections.
    if (response.status === 404) {
      cached = { iceServers: STUN_SERVERS, expiresAt: Date.now() + 60_000 };
      return cached.iceServers;
    }
    if (!response.ok) throw new Error("Connection relay configuration is unavailable.");

    const config = await response.json() as Partial<IceConfiguration>;
    if (!Array.isArray(config.iceServers) || config.iceServers.length === 0 ||
      !config.iceServers.every(isIceServer) || typeof config.expiresAt !== "number" ||
      !Number.isFinite(config.expiresAt) || config.expiresAt <= Date.now()) {
      throw new Error("Invalid connection relay configuration.");
    }
    cached = { iceServers: config.iceServers, expiresAt: config.expiresAt };
    return cached.iceServers;
  }

  return (): Promise<RTCIceServer[]> => {
    if (cached && cached.expiresAt > Date.now() + 30_000) return Promise.resolve(cached.iceServers);
    pending ??= load().finally(() => { pending = null; });
    return pending;
  };
}
