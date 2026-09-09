import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebRTCManager } from "./webrtc";

class FakeChannel extends EventTarget {
  readyState = "connecting";
  binaryType = "";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = "closed";
    this.onclose?.();
    this.dispatchEvent(new Event("close"));
  });
}

class FakePeer {
  static instances: FakePeer[] = [];
  connectionState = "new";
  iceConnectionState = "new";
  sctp = { maxMessageSize: 65536 };
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  ondatachannel = null;
  channel = new FakeChannel();
  constructor(readonly configuration?: RTCConfiguration) {
    FakePeer.instances.push(this);
  }
  createDataChannel = () => this.channel;
  createOffer = async () => ({ type: "offer", sdp: "test" });
  createAnswer = async () => ({ type: "answer", sdp: "test" });
  setLocalDescription = async () => {};
  setRemoteDescription = async (value: RTCSessionDescriptionInit) => {
    this.remoteDescription = value;
  };
  addIceCandidate = vi.fn(async () => {});
  close = vi.fn();
}

describe("WebRTC connection recovery", () => {
  let manager: WebRTCManager;
  let onStateChange: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    FakePeer.instances = [];
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    onStateChange = vi.fn();
    manager = new WebRTCManager([], {
      onStateChange,
      onMessage: vi.fn(),
      onIceCandidate: vi.fn(),
      onOffer: vi.fn(),
      onAnswer: vi.fn(),
    });
  });
  afterEach(() => {
    manager.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports a stalled handshake after 15 seconds", async () => {
    await manager.createOffer();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith("closed");
  });

  it("pauses handshake deadlines while hidden and gives foreground negotiation a full grace period", async () => {
    await manager.createOffer();
    await vi.advanceTimersByTimeAsync(10_000);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onStateChange).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(onStateChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith("closed");
  });

  it("does not expire a handshake while its peer is backgrounded", async () => {
    await manager.createOffer();
    manager.setPeerBackground(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onStateChange).not.toHaveBeenCalled();
    manager.setPeerBackground(false);
    const channel = FakePeer.instances[0].channel;
    channel.readyState = "open";
    channel.onopen?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith("open");
  });

  it("rechecks a recovered connection without replacing its open data channel", async () => {
    await manager.createOffer();
    const pc = FakePeer.instances[0];
    pc.channel.readyState = "open";
    pc.channel.onopen?.();
    pc.connectionState = "connected";
    manager.recover();
    expect(pc.close).not.toHaveBeenCalled();
    expect(manager.send(new Uint8Array([42]))).toBe(true);
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith("open");
  });

  it("reports a closed data channel discovered after foregrounding", async () => {
    await manager.createOffer();
    FakePeer.instances[0].channel.readyState = "closed";
    manager.recover();
    manager.recover();
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
    expect(FakePeer.instances[0].addIceCandidate).toHaveBeenCalledWith(
      candidate,
    );
  });

  it.each(["offer", "answer"])(
    "loads TURN credentials before creating a peer for an %s",
    async (role) => {
      const iceServers = [
        {
          urls: "turns:turn.cloudflare.com:443",
          username: "user",
          credential: "short-lived",
        },
      ];
      const load = vi.fn(async () => iceServers);
      manager = new WebRTCManager(load, {
        onStateChange,
        onMessage: vi.fn(),
        onIceCandidate: vi.fn(),
        onOffer: vi.fn(),
        onAnswer: vi.fn(),
      });
      if (role === "offer") await manager.createOffer();
      else await manager.handleOffer({ type: "offer", sdp: "test" });
      expect(load).toHaveBeenCalledOnce();
      expect(FakePeer.instances[0].configuration).toEqual({ iceServers });
    },
  );

  it("does not resurrect a closed manager when credentials finish loading", async () => {
    let resolve!: (servers: RTCIceServer[]) => void;
    manager = new WebRTCManager(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
      {
        onStateChange,
        onMessage: vi.fn(),
        onIceCandidate: vi.fn(),
        onOffer: vi.fn(),
        onAnswer: vi.fn(),
      },
    );
    const offer = manager.createOffer();
    manager.close();
    resolve([]);
    await expect(offer).rejects.toThrow("cancelled");
    expect(FakePeer.instances).toHaveLength(0);
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it("waits for the send buffer to drain before sending a file frame", async () => {
    await manager.createOffer();
    const channel = FakePeer.instances[0].channel;
    channel.readyState = "open";
    channel.onopen?.();
    channel.bufferedAmount = 2 * 1024 * 1024;
    const data = new Uint8Array([1, 2, 3]);
    const pending = manager.sendBuffered(data, new AbortController().signal);
    expect(channel.send).not.toHaveBeenCalled();
    expect(channel.bufferedAmountLowThreshold).toBe(512 * 1024);
    // Text remains available while the file sender waits for buffer space.
    expect(manager.send(new Uint8Array([42]))).toBe(true);
    expect(channel.send).toHaveBeenCalledTimes(1);
    channel.bufferedAmount = 512 * 1024;
    channel.dispatchEvent(new Event("bufferedamountlow"));
    await expect(pending).resolves.toBe(true);
    expect(channel.send).toHaveBeenLastCalledWith(data);
    expect(channel.send).toHaveBeenCalledTimes(2);
    // A stale event cannot send the frame twice or retain a timeout.
    channel.dispatchEvent(new Event("bufferedamountlow"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it.each(["abort", "close", "error", "manager-close"])(
    "wakes a blocked file send on %s and removes listeners",
    async (reason) => {
      await manager.createOffer();
      const channel = FakePeer.instances[0].channel;
      channel.readyState = "open";
      channel.onopen?.();
      channel.bufferedAmount = 2 * 1024 * 1024;
      const removeListener = vi.spyOn(channel, "removeEventListener");
      const controller = new AbortController();
      const pending = manager.sendBuffered(
        new Uint8Array([1]),
        controller.signal,
      );
      if (reason === "abort") controller.abort();
      else if (reason === "manager-close") manager.close();
      else if (reason === "close") channel.close();
      else channel.dispatchEvent(new Event("error"));
      await expect(pending).resolves.toBe(false);
      expect(channel.send).not.toHaveBeenCalled();
      expect(removeListener.mock.calls.map(([type]) => type)).toEqual([
        "bufferedamountlow",
        "close",
        "error",
      ]);
      channel.bufferedAmount = 0;
      channel.dispatchEvent(new Event("bufferedamountlow"));
      expect(channel.send).not.toHaveBeenCalled();
    },
  );

  it.each(["local", "peer"])("keeps a blocked file send alive while the %s browser is backgrounded", async (side) => {
    await manager.createOffer();
    const channel = FakePeer.instances[0].channel;
    channel.readyState = "open";
    channel.onopen?.();
    channel.bufferedAmount = 2 * 1024 * 1024;
    if (side === "local") {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    } else manager.setPeerBackground(true);
    const resolved = vi.fn();
    const pending = manager.sendBuffered(new Uint8Array([7]), new AbortController().signal).then((value) => {
      resolved(value);
      return value;
    });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(resolved).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    manager.setPeerBackground(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(resolved).not.toHaveBeenCalled();
    channel.bufferedAmount = 0;
    channel.dispatchEvent(new Event("bufferedamountlow"));
    await expect(pending).resolves.toBe(true);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith(new Uint8Array([7]));
  });

  it("times out a buffer which never drains", async () => {
    await manager.createOffer();
    const channel = FakePeer.instances[0].channel;
    channel.readyState = "open";
    channel.onopen?.();
    channel.bufferedAmount = 2 * 1024 * 1024;
    const pending = manager.sendBuffered(
      new Uint8Array([1]),
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toBe(false);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("enforces the negotiated message size for normal and buffered sends", async () => {
    await manager.createOffer();
    const pc = FakePeer.instances[0];
    pc.channel.readyState = "open";
    pc.sctp.maxMessageSize = 1024;
    const signal = new AbortController().signal;
    expect(manager.maxMessageSize).toBe(1024);
    await expect(
      manager.sendBuffered(new Uint8Array(1025), signal),
    ).resolves.toBe(false);
    expect(manager.send(new Uint8Array(1025))).toBe(false);
    expect(pc.channel.send).not.toHaveBeenCalled();
    await expect(
      manager.sendBuffered(new Uint8Array(1024), signal),
    ).resolves.toBe(true);
    expect(manager.send(new Uint8Array(1024))).toBe(true);
    expect(pc.channel.send).toHaveBeenCalledTimes(2);
  });

  it("reports a channel send exception as failure without throwing", async () => {
    await manager.createOffer();
    const channel = FakePeer.instances[0].channel;
    channel.readyState = "open";
    channel.send.mockImplementation(() => {
      throw new DOMException("Buffer full", "OperationError");
    });
    await expect(
      manager.sendBuffered(new Uint8Array([1]), new AbortController().signal),
    ).resolves.toBe(false);
    expect(manager.send(new Uint8Array([1]))).toBe(false);
  });

  it("rejects closed channels and already-aborted transfers before sending", async () => {
    const signal = new AbortController().signal;
    await expect(
      manager.sendBuffered(new Uint8Array([1]), signal),
    ).resolves.toBe(false);
    await manager.createOffer();
    const channel = FakePeer.instances[0].channel;
    await expect(
      manager.sendBuffered(new Uint8Array([1]), signal),
    ).resolves.toBe(false);
    channel.readyState = "open";
    const controller = new AbortController();
    controller.abort();
    await expect(
      manager.sendBuffered(new Uint8Array([1]), controller.signal),
    ).resolves.toBe(false);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("cannot send a waiting frame into a replacement connection", async () => {
    await manager.createOffer();
    const oldChannel = FakePeer.instances[0].channel;
    oldChannel.readyState = "open";
    oldChannel.bufferedAmount = 2 * 1024 * 1024;
    const pending = manager.sendBuffered(
      new Uint8Array([1]),
      new AbortController().signal,
    );
    await manager.createOffer();
    const replacement = FakePeer.instances[1].channel;
    replacement.readyState = "open";
    oldChannel.bufferedAmount = 0;
    oldChannel.dispatchEvent(new Event("bufferedamountlow"));
    await expect(pending).resolves.toBe(false);
    expect(oldChannel.send).not.toHaveBeenCalled();
    expect(replacement.send).not.toHaveBeenCalled();
    await expect(
      manager.sendBuffered(new Uint8Array([2]), new AbortController().signal),
    ).resolves.toBe(true);
    expect(replacement.send).toHaveBeenCalledWith(new Uint8Array([2]));
  });
});
