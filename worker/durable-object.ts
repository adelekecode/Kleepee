/**
 * Session Durable Object — per-session state + WebSocket hibernation
 *
 * Uses Cloudflare Workers Durable Object WebSocket hibernation API:
 * ctx.acceptWebSocket / ctx.getWebSockets()
 *
 * Requirements: 3.3, 3.4, 9.1, 9.2, 9.4, 11.1–11.6
 */

interface Env {
  SESSION_DO: DurableObjectNamespace;
}

export class SessionDurableObject implements DurableObject {
  /** peerId → WebSocket (max 2 entries) */
  private peers: Map<string, WebSocket> = new Map();

  private sessionState: "WAITING" | "CONNECTING" | "CONNECTED" | "DISCONNECTED" | "EXPIRED" =
    "WAITING";

  /** Unix ms timestamp when this DO was first instantiated */
  readonly createdAt: number = Date.now();

  constructor(
    private ctx: DurableObjectState,
    _env: Env
  ) {}

  // ---------------------------------------------------------------------------
  // fetch — HTTP GET (state) and WebSocket upgrade
  // ---------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    // Requirement 9.4 / design: expired sessions return 410 for any request
    if (this.sessionState === "EXPIRED") {
      return new Response(JSON.stringify({ error: "Session expired" }), {
        status: 410,
        headers: { "Content-Type": "application/json" },
      });
    }

    const upgradeHeader = request.headers.get("Upgrade");

    // WebSocket upgrade path
    if (upgradeHeader?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    // Plain HTTP GET — return session state
    if (request.method === "GET") {
      return new Response(
        JSON.stringify({
          sessionState: this.sessionState,
          deviceCount: this.peers.size,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  // ---------------------------------------------------------------------------
  // webSocketMessage — route signal.* messages to the OTHER peer
  // ---------------------------------------------------------------------------

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    let parsed: { type?: string } & Record<string, unknown>;
    try {
      parsed = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      // Malformed JSON — silently discard
      return;
    }

    const { type } = parsed;
    if (
      type !== "signal.offer" &&
      type !== "signal.answer" &&
      type !== "signal.ice"
    ) {
      // Unknown message type — discard
      return;
    }

    const senderId = ws.deserializeAttachment() as string | null;
    const otherPeer = this.findOtherPeer(senderId);
    if (!otherPeer) {
      // Other peer not present yet — discard
      return;
    }

    otherPeer.send(typeof message === "string" ? message : new TextDecoder().decode(message));
  }

  // ---------------------------------------------------------------------------
  // webSocketClose — clean up + notify remaining peer
  // ---------------------------------------------------------------------------

  webSocketClose(ws: WebSocket): void {
    const peerId = ws.deserializeAttachment() as string | null;
    if (peerId) {
      this.peers.delete(peerId);
    }

    // Notify any remaining peer
    for (const [, peerWs] of this.peers) {
      try {
        peerWs.send(JSON.stringify({ type: "peer.leave" }));
      } catch {
        // Peer already closed — ignore
      }
    }

    // If both peers are gone, set a short grace-period alarm (30 s)
    if (this.peers.size === 0) {
      this.ctx.storage.setAlarm(Date.now() + 30 * 1000);
    }
  }

  // ---------------------------------------------------------------------------
  // alarm — expire session and notify any lingering connections
  // ---------------------------------------------------------------------------

  async alarm(): Promise<void> {
    // Only expire if in WAITING state (10-min timeout) or both peers are gone
    // (grace-period after both disconnected). If the session has active peers,
    // the alarm was set during a previous state and no longer applies.
    if (this.sessionState !== "WAITING" && this.peers.size > 0) {
      return;
    }

    this.sessionState = "EXPIRED";

    const expiredMessage = JSON.stringify({ type: "session.expired" });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(expiredMessage);
        ws.close(4410, "Session expired");
      } catch {
        // Already closed
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private handleWebSocketUpgrade(request: Request): Response {
    // Requirement 3.4 / 9.4: max 2 peers per session
    if (this.peers.size >= 2) {
      return new Response(JSON.stringify({ error: "Session is full" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Read optional deviceName from query string (e.g. ?deviceName=Blue+Panda)
    const url = new URL(request.url);
    const deviceName = url.searchParams.get("deviceName") ?? "Unknown Device";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // Use hibernation API — lets the DO sleep between messages
    this.ctx.acceptWebSocket(server);

    const peerId = crypto.randomUUID();
    // Attach peerId to the socket so we can identify it in handlers
    server.serializeAttachment(peerId);
    this.peers.set(peerId, server);

    // On first peer join, set a 10-minute alarm (Requirement 2.6 / 9.1)
    if (this.peers.size === 1) {
      this.ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000);
    }

    // Notify the OTHER peer that a new device joined (Requirement 11.4)
    this.notifyOtherPeer(peerId, JSON.stringify({ type: "peer.join", deviceName }));

    // Advance session state on second peer join (Requirement 3.3)
    if (this.peers.size === 2 && this.sessionState === "WAITING") {
      this.sessionState = "CONNECTING";
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Send a message to every peer EXCEPT the one identified by `senderId`.
   */
  private notifyOtherPeer(senderId: string | null, message: string): void {
    for (const [id, ws] of this.peers) {
      if (id !== senderId) {
        try {
          ws.send(message);
        } catch {
          // Peer already closed — ignore
        }
      }
    }
  }

  /**
   * Return the WebSocket of the peer that is NOT `senderId`, or null if not found.
   */
  private findOtherPeer(senderId: string | null): WebSocket | null {
    for (const [id, ws] of this.peers) {
      if (id !== senderId) {
        return ws;
      }
    }
    return null;
  }
}
