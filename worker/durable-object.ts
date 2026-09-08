interface Env {
  SESSION_DO: DurableObjectNamespace;
}

type DurableSessionState =
  | "WAITING"
  | "CONNECTING"
  | "CONNECTED"
  | "DISCONNECTED"
  | "EXPIRED";

interface PeerAttachment {
  peerId: string;
  deviceId: string;
  deviceName: string;
}

interface PeerRecord {
  ws: WebSocket;
  attachment: PeerAttachment;
}

const SESSION_STATE_KEY = "sessionState";
const WAITING_TIMEOUT_MS = 10 * 60 * 1000;
const EMPTY_SESSION_TIMEOUT_MS = 5 * 60 * 1000;

export class SessionDurableObject implements DurableObject {
  private peers: Map<string, PeerRecord> = new Map();
  private sessionState: DurableSessionState = "WAITING";

  constructor(
    private ctx: DurableObjectState,
    _env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    await this.loadSessionState();
    this.restorePeers();

    if (this.sessionState === "EXPIRED") {
      return this.json({ error: "Session expired" }, 410);
    }

    const upgradeHeader = request.headers.get("Upgrade");

    if (upgradeHeader?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    if (request.method === "GET") {
      return this.json({
        sessionState: this.sessionState,
        deviceCount: this.peers.size,
      });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.restorePeers();

    const wireMessage = typeof message === "string" ? message : new TextDecoder().decode(message);
    let parsed: { type?: string } & Record<string, unknown>;

    try {
      parsed = JSON.parse(wireMessage);
    } catch {
      return;
    }

    if (
      parsed.type !== "signal.offer" &&
      parsed.type !== "signal.answer" &&
      parsed.type !== "signal.ice"
    ) {
      return;
    }

    const sender = this.getAttachment(ws);
    const otherPeer = this.findOtherPeer(sender?.peerId ?? null);
    otherPeer?.send(wireMessage);
  }

  webSocketClose(ws: WebSocket): void {
    this.restorePeers();

    const attachment = this.getAttachment(ws);
    if (!attachment) return;

    const currentPeer = this.peers.get(attachment.peerId);
    if (currentPeer?.ws !== ws) return;

    this.peers.delete(attachment.peerId);

    for (const [, peer] of this.peers) {
      try {
        peer.ws.send(JSON.stringify({ type: "peer.leave" }));
      } catch {
        /* ignore closed sockets */
      }
    }

    void this.updateStateAfterClose();
  }

  async alarm(): Promise<void> {
    await this.loadSessionState();
    this.restorePeers();

    if (this.sessionState !== "WAITING" && this.peers.size > 0) {
      return;
    }

    if (this.sessionState === "CONNECTED" && this.peers.size > 0) {
      return;
    }

    this.sessionState = "EXPIRED";
    await this.ctx.storage.put(SESSION_STATE_KEY, this.sessionState);

    const expiredMessage = JSON.stringify({ type: "session.expired" });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(expiredMessage);
        ws.close(4410, "Session expired");
      } catch {
        /* ignore closed sockets */
      }
    }
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const deviceId = url.searchParams.get("deviceId") || crypto.randomUUID();
    const deviceName = url.searchParams.get("deviceName") || "Unknown Device";

    const sameDevicePeer = this.findPeerByDeviceId(deviceId);
    if (sameDevicePeer) {
      this.peers.delete(sameDevicePeer.attachment.peerId);
      try {
        sameDevicePeer.ws.close(4401, "Device reconnected");
      } catch {
        /* ignore closed sockets */
      }
    }

    if (this.peers.size >= 2) {
      return this.json({ error: "Session is full" }, 409);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const attachment: PeerAttachment = {
      peerId: crypto.randomUUID(),
      deviceId,
      deviceName,
    };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    this.peers.set(attachment.peerId, { ws: server, attachment });

    if (this.peers.size === 1) {
      await this.setSessionState("WAITING");
      await this.ctx.storage.setAlarm(Date.now() + WAITING_TIMEOUT_MS);
    }

    if (this.peers.size === 2) {
      await this.setSessionState("CONNECTED");
      await this.ctx.storage.deleteAlarm();
    }

    this.notifyOtherPeer(
      attachment.peerId,
      JSON.stringify({ type: "peer.join", deviceName: attachment.deviceName }),
    );

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async updateStateAfterClose(): Promise<void> {
    this.restorePeers();

    if (this.sessionState === "EXPIRED") {
      return;
    }

    if (this.peers.size === 0) {
      await this.setSessionState("DISCONNECTED");
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_SESSION_TIMEOUT_MS);
      return;
    }

    await this.setSessionState("DISCONNECTED");
  }

  private async loadSessionState(): Promise<void> {
    const storedState = await this.ctx.storage.get<DurableSessionState>(SESSION_STATE_KEY);
    this.sessionState = storedState ?? this.sessionState;
  }

  private async setSessionState(state: DurableSessionState): Promise<void> {
    this.sessionState = state;
    await this.ctx.storage.put(SESSION_STATE_KEY, state);
  }

  private restorePeers(): void {
    const restoredPeers = new Map<string, PeerRecord>();

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.getAttachment(ws);
      if (!attachment) continue;
      restoredPeers.set(attachment.peerId, { ws, attachment });
    }

    this.peers = restoredPeers;
  }

  private getAttachment(ws: WebSocket): PeerAttachment | null {
    const attachment = ws.deserializeAttachment() as PeerAttachment | string | null;

    if (!attachment) {
      return null;
    }

    if (typeof attachment === "string") {
      return {
        peerId: attachment,
        deviceId: attachment,
        deviceName: "Unknown Device",
      };
    }

    if (
      typeof attachment.peerId === "string" &&
      typeof attachment.deviceId === "string" &&
      typeof attachment.deviceName === "string"
    ) {
      return attachment;
    }

    return null;
  }

  private findPeerByDeviceId(deviceId: string): PeerRecord | null {
    for (const [, peer] of this.peers) {
      if (peer.attachment.deviceId === deviceId) {
        return peer;
      }
    }

    return null;
  }

  private notifyOtherPeer(senderId: string | null, message: string): void {
    for (const [id, peer] of this.peers) {
      if (id !== senderId) {
        try {
          peer.ws.send(message);
        } catch {
          /* ignore closed sockets */
        }
      }
    }
  }

  private findOtherPeer(senderId: string | null): WebSocket | null {
    for (const [id, peer] of this.peers) {
      if (id !== senderId) {
        return peer.ws;
      }
    }

    return null;
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
