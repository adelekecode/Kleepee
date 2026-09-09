export interface TurnEnv {
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface IceServerConfiguration {
  iceServers: IceServer[];
  expiresAt: number;
  relayAvailable: boolean;
}

const CREDENTIAL_TTL_SECONDS = 3600;

// Accept only the documented Cloudflare endpoints and browser-usable ports.
// Provider metadata and blocked port 53 must never reach RTCPeerConnection.
function usableUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return (
    /^stun:stun\.cloudflare\.com:3478$/.test(value) ||
    /^turn:turn\.cloudflare\.com:3478\?transport=(udp|tcp)$/.test(value) ||
    /^turn:turn\.cloudflare\.com:80\?transport=tcp$/.test(value) ||
    /^turns:turn\.cloudflare\.com:(5349|443)\?transport=tcp$/.test(value)
  );
}

function sanitizeIceServers(value: unknown): IceServer[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("iceServers" in value) ||
    !Array.isArray(value.iceServers)
  ) {
    throw new Error("Invalid relay configuration");
  }

  const servers: IceServer[] = [];
  for (const entry of value.iceServers) {
    if (!entry || typeof entry !== "object") continue;
    const candidates: unknown[] = Array.isArray(entry.urls)
      ? entry.urls
      : [entry.urls];
    const urls = [...new Set(candidates.filter(usableUrl))];
    if (urls.length === 0) continue;

    if (urls.some((url) => url.startsWith("turn"))) {
      if (
        typeof entry.username !== "string" ||
        !entry.username.trim() ||
        typeof entry.credential !== "string" ||
        !entry.credential.trim()
      ) {
        throw new Error("Invalid relay configuration");
      }
      servers.push({
        urls,
        username: entry.username,
        credential: entry.credential,
      });
    } else {
      servers.push({ urls });
    }
  }

  if (
    !servers.some((server) => server.urls.some((url) => url.startsWith("turn")))
  ) {
    throw new Error("Invalid relay configuration");
  }
  return servers;
}

export async function getIceServerConfiguration(
  env: TurnEnv,
): Promise<IceServerConfiguration> {
  const keyId = env.TURN_KEY_ID?.trim();
  const apiToken = env.TURN_KEY_API_TOKEN?.trim();
  if (!keyId && !apiToken) {
    return {
      iceServers: [
        { urls: ["stun:stun.l.google.com:19302"] },
        { urls: ["stun:stun1.l.google.com:19302"] },
      ],
      expiresAt: Date.now() + 60_000,
      relayAvailable: false,
    };
  }
  if (!keyId || !apiToken) throw new Error("Relay unavailable");

  // Compute expiry before making the request so network time cannot extend TTL.
  const expiresAt = Date.now() + CREDENTIAL_TTL_SECONDS * 1000;
  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok) throw new Error("Relay unavailable");
    return {
      iceServers: sanitizeIceServers(await response.json()),
      expiresAt,
      relayAvailable: true,
    };
  } catch {
    // Never expose provider responses or server credentials to clients/logs.
    throw new Error("Relay unavailable");
  }
}
