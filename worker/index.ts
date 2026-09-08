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

interface Env {
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

function corsJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
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
  const { pathname, method } = url;

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
  const sessionMatch = pathname.match(/^\/sessions\/([A-Z0-9]+)$/i);

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

// ---------------------------------------------------------------------------
// Forward a request to the appropriate Durable Object
// ---------------------------------------------------------------------------

function forwardToDO(request: Request, env: Env, sessionId: string): Promise<Response> {
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

  return stub.fetch(doRequest);
}

// ---------------------------------------------------------------------------
// Default export — Worker handler
// ---------------------------------------------------------------------------

export default {
  fetch: handleFetch,
} satisfies ExportedHandler<Env>;
