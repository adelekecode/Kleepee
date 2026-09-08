import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebRTCManager } from "./webrtc";

class FakeChannel {
  readyState = "connecting";
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = "closed"; this.onclose?.(); });
}

class FakePeer {
  static instances: FakePeer[] = [];
  connectionState = "new";
  iceConnectionState = "new";
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  ondatachannel = null;
  channel = new FakeChannel();
  constructor(readonly configuration?: RTCConfiguration) { FakePeer.instances.push(this); }
  createDataChannel = () => this.channel;
  createOffer = async () => ({ type: "offer", sdp: "test" });
  createAnswer = async () => ({ type: "answer", sdp: "test" });
  setLocalDescription = async () => {};
  setRemoteDescription = async (value: RTCSessionDescriptionInit) => { this.remoteDescription = value; };
  addIceCandidate = vi.fn(async () => {});
  close = vi.fn();
}

describe("WebRTC connection recovery", () => {
  let manager: WebRTCManager;
  let onStateChange: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    FakePeer.instances = [];
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    onStateChange = vi.fn();
    manager = new WebRTCManager([], {
      onStateChange, onMessage: vi.fn(), onIceCandidate: vi.fn(),
      onOffer: vi.fn(), onAnswer: vi.fn(),
    });
  });
  afterEach(() => { manager.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("reports a stalled handshake after 15 seconds", async () => {
    await manager.createOffer();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith("closed");
  });

  it("reports ICE failure once even if the channel also errors", async () => {
    await manager.createOffer();
    const pc = FakePeer.instances[0];
    pc.iceConnectionState = "failed";
    pc.oniceconnectionstatechange?.();
    pc.channel.onerror?.();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith("closed");
  });

  it("cancels the handshake deadline when the data channel opens", async () => {
    await manager.createOffer();
    const pc = FakePeer.instances[0];
    pc.channel.readyState = "open";
    pc.channel.onopen?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith("open");
  });

  it("allows a briefly disconnected connection to recover", async () => {
    await manager.createOffer();
    const pc = FakePeer.instances[0];
    pc.channel.readyState = "open";
    pc.channel.onopen?.();
    pc.connectionState = "disconnected";
    pc.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(5_000);
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith("open");
  });

  it("closes replaced connections without triggering a reconnect loop", async () => {
    await manager.createOffer();
    const oldPC = FakePeer.instances[0];
    await manager.createOffer();
    expect(oldPC.close).toHaveBeenCalledOnce();
    manager.close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it("keeps ICE received before the remote offer until it can be applied", async () => {
    const candidate = { candidate: "candidate:test" };
    await manager.addIceCandidate(candidate);
    await manager.handleOffer({ type: "offer", sdp: "test" });
    expect(FakePeer.instances[0].addIceCandidate).toHaveBeenCalledWith(candidate);
  });

  it.each(["offer", "answer"])("loads TURN credentials before creating a peer for an %s", async (role) => {
    const iceServers = [{ urls: "turns:turn.cloudflare.com:443", username: "user", credential: "short-lived" }];
    const load = vi.fn(async () => iceServers);
    manager = new WebRTCManager(load, {
      onStateChange, onMessage: vi.fn(), onIceCandidate: vi.fn(), onOffer: vi.fn(), onAnswer: vi.fn(),
    });
    if (role === "offer") await manager.createOffer();
    else await manager.handleOffer({ type: "offer", sdp: "test" });
    expect(load).toHaveBeenCalledOnce();
    expect(FakePeer.instances[0].configuration).toEqual({ iceServers });
  });

  it("does not resurrect a closed manager when credentials finish loading", async () => {
    let resolve!: (servers: RTCIceServer[]) => void;
    manager = new WebRTCManager(() => new Promise((done) => { resolve = done; }), {
      onStateChange, onMessage: vi.fn(), onIceCandidate: vi.fn(), onOffer: vi.fn(), onAnswer: vi.fn(),
    });
    const offer = manager.createOffer();
    manager.close();
    resolve([]);
    await expect(offer).rejects.toThrow("cancelled");
    expect(FakePeer.instances).toHaveLength(0);
    expect(onStateChange).not.toHaveBeenCalled();
  });
});
