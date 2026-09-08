/**
 * Worker Router — Kleepee V1 signaling server entry point
 *
 * Routes:
 *   POST /sessions          → create session, return { sessionId }
 *   GET  /sessions/:id      → forward to DO, return state JSON
 *   GET  /sessions/:id/ws   → forward WebSocket upgrade to DO
 *   GET  /sessions/:id      with Upgrade: websocket → forward WebSocket upgrade to DO
 *   All other routes        → 404
 *
 * Requirements: 11.1, 11.2, 11.3
 */

export { SessionDurableObject } from "./durable-object";
import { getIceServerConfiguration, type TurnEnv } from "./ice-servers";

interface Env extends TurnEnv {
  SESSION_DO: DurableObjectNamespace;
}

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Upgrade, Connection",
};

function corsJson(body: unknown, status = 200, noStore = false): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...(noStore ? { "Cache-Control": "no-store" } : {}),
    },
  });
}

function corsText(body: string, status = 404): Response {
  return new Response(body, {
    status,
    headers: CORS_HEADERS,
  });
}

// ---------------------------------------------------------------------------
// Session ID generation — 6 uppercase alphanumeric characters
// ---------------------------------------------------------------------------

function generateSessionId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("");
}

// ---------------------------------------------------------------------------
// Worker fetch handler
// ---------------------------------------------------------------------------

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pathname = normalizePath(url.pathname);
  const { method } = request;

  // Preflight CORS
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // POST /sessions — create a new session
  if (method === "POST" && pathname === "/sessions") {
    const sessionId = generateSessionId();
    const doId = env.SESSION_DO.idFromName(sessionId);
    // Touch the DO to initialise it (optional, but ensures it's warm)
    env.SESSION_DO.get(doId);
    return corsJson({ sessionId }, 200);
  }

  // Route patterns for /sessions/:sessionId and /sessions/:sessionId/ws
  const sessionWsMatch = pathname.match(/^\/sessions\/([A-Z0-9]+)\/ws$/i);
  const sessionIceMatch = pathname.match(/^\/sessions\/([A-Z0-9]+)\/ice-servers$/i);
  const sessionMatch = pathname.match(/^\/sessions\/([A-Z0-9]+)$/i);

  if (method === "GET" && sessionIceMatch) {
    return sessionIceServers(request, env, sessionIceMatch[1].toUpperCase());
  }

  // GET /sessions/:sessionId/ws  → WebSocket upgrade to DO
  if (method === "GET" && sessionWsMatch) {
    const sessionId = sessionWsMatch[1].toUpperCase();
    return forwardToDO(request, env, sessionId);
  }

  if (method === "GET" && sessionMatch) {
    const sessionId = sessionMatch[1].toUpperCase();
    const upgradeHeader = request.headers.get("Upgrade");

    // GET /sessions/:sessionId with Upgrade: websocket → WebSocket upgrade to DO
    if (upgradeHeader?.toLowerCase() === "websocket") {
      return forwardToDO(request, env, sessionId);
    }

    // GET /sessions/:sessionId → return state JSON from DO
    return forwardToDO(request, env, sessionId);
  }

  // All other routes → 404
  return corsText("Not Found", 404);
}

async function sessionIceServers(request: Request, env: Env, sessionId: string): Promise<Response> {
  try {
    const deviceId = new URL(request.url).searchParams.get("deviceId");
    if (!deviceId) return corsJson({ error: "Device identity required" }, 400, true);

    // Fetch state without forwarding Upgrade headers: this route must never
    // consume a peer slot or mint credentials for an empty/expired session.
    const stateUrl = new URL(request.url);
    stateUrl.pathname = "/";
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
    const stateResponse = await stub.fetch(new Request(stateUrl));
    if (stateResponse.status === 410) {
      return corsJson({ error: "Session expired" }, 410, true);
    }
    if (!stateResponse.ok) return corsJson({ error: "Session unavailable" }, 503, true);
    const state = await stateResponse.json() as {
      sessionState: string;
      deviceCount: number;
      canJoin: boolean;
    };
    if (state.sessionState === "EXPIRED") return corsJson({ error: "Session expired" }, 410, true);
    if (state.deviceCount === 0) return corsJson({ error: "Session not found" }, 404, true);
    if (state.canJoin === false) return corsJson({ error: "Session is full" }, 409, true);
    if (typeof state.deviceCount !== "number" || typeof state.canJoin !== "boolean") {
      return corsJson({ error: "Session unavailable" }, 503, true);
    }

    return corsJson(await getIceServerConfiguration(env), 200, true);
  } catch {
    return corsJson({ error: "Connection relay unavailable" }, 503, true);
  }
}

function normalizePath(pathname: string): string {
  const withoutTrailingSlash = pathname.replace(/\/+$/, "") || "/";

  if (withoutTrailingSlash === "/api") {
    return "/";
  }

  if (withoutTrailingSlash.startsWith("/api/")) {
    return withoutTrailingSlash.slice(4) || "/";
  }

  return withoutTrailingSlash;
}

// ---------------------------------------------------------------------------
// Forward a request to the appropriate Durable Object
// ---------------------------------------------------------------------------

async function forwardToDO(request: Request, env: Env, sessionId: string): Promise<Response> {
  const doId = env.SESSION_DO.idFromName(sessionId);
  const stub = env.SESSION_DO.get(doId);

  // Reconstruct the URL so the DO sees a clean path at its own stub URL.
  // The Durable Object only cares about the Upgrade header and method,
  // not the path — it handles all traffic via its single fetch() handler.
  const doUrl = new URL(request.url);
  doUrl.pathname = "/";

  const doRequest = new Request(doUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });

  const response = await stub.fetch(doRequest);

  if (response.status === 101) {
    return response;
  }

  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Default export — Worker handler
// ---------------------------------------------------------------------------

export default {
  fetch: handleFetch,
} satisfies ExportedHandler<Env>;
