import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSession, type UseSessionResult } from "./useSession";
import { encodeFileFrame } from "../lib/fileTransfer";
import type { WebRTCCallbacks } from "../types";

const cryptoMocks = vi.hoisted(() => ({
  deriveKey: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  decryptBytes: vi.fn(),
  encryptBytes: vi.fn(),
  generateSessionSecret: vi.fn(),
}));

const rtcMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    close: ReturnType<typeof vi.fn>;
    createOffer: ReturnType<typeof vi.fn>;
    handleOffer: ReturnType<typeof vi.fn>;
    handleAnswer: ReturnType<typeof vi.fn>;
    addIceCandidate: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    sendBuffered: ReturnType<typeof vi.fn>;
    maxMessageSize: number;
    callbacks: WebRTCCallbacks;
    dataChannelState: RTCDataChannelState | null;
  }>,
}));

vi.mock("../lib/crypto", () => ({
  deriveKey: cryptoMocks.deriveKey,
  encrypt: cryptoMocks.encrypt,
  decrypt: cryptoMocks.decrypt,
  decryptBytes: cryptoMocks.decryptBytes,
  encryptBytes: cryptoMocks.encryptBytes,
  generateSessionSecret: cryptoMocks.generateSessionSecret,
}));

vi.mock("../lib/webrtc", () => ({
  WebRTCManager: class {
    close = vi.fn();
    createOffer = vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" }));
    handleOffer = vi.fn(async () => ({ type: "answer", sdp: "answer-sdp" }));
    handleAnswer = vi.fn(async () => {});
    addIceCandidate = vi.fn(async () => {});
    send = vi.fn(() => true);
    sendBuffered = vi.fn(async () => true);
    maxMessageSize = 65536;
    dataChannelState: RTCDataChannelState | null = null;

    constructor(_ice: unknown, readonly callbacks: WebRTCCallbacks) {
      rtcMocks.instances.push(this);
    }
  },
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 } as CloseEvent);
  });

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

function renderSessionHook() {
  const element = document.createElement("div");
  document.body.appendChild(element);
  let root: Root;
  let latest: UseSessionResult | null = null;

  function Probe() {
    latest = useSession();
    return null;
  }

  act(() => {
    root = createRoot(element);
    root.render(<Probe />);
  });

  return {
    get current() {
      if (!latest) throw new Error("Hook did not render");
      return latest;
    },
    cleanup: () => {
      act(() => root.unmount());
      element.remove();
    },
  };
}

describe("useSession join recovery", () => {
  let hook: ReturnType<typeof renderSessionHook> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
    cryptoMocks.deriveKey.mockResolvedValue({} as CryptoKey);
    cryptoMocks.encrypt.mockResolvedValue(new Uint8Array([1]));
    cryptoMocks.decrypt.mockResolvedValue("{}");
    cryptoMocks.decryptBytes.mockResolvedValue(new TextEncoder().encode("{}"));
    cryptoMocks.encryptBytes.mockResolvedValue(new Uint8Array([1]));
    cryptoMocks.generateSessionSecret.mockReturnValue("secret");
    rtcMocks.instances.length = 0;
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ sessionState: "DISCONNECTED", deviceCount: 1 }),
      { headers: { "Content-Type": "application/json" }, status: 200 },
    )));
  });

  afterEach(() => {
    hook?.cleanup();
    hook = null;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not restore a previous session when the user opens an explicit join link", () => {
    window.sessionStorage.setItem("kleepee.session.current", JSON.stringify({
      sessionId: "OLD",
      sessionSecret: "old-secret",
      role: "initiator",
      peerDeviceName: null,
      items: [],
      initialText: "old text",
      initialTextSent: false,
    }));
    window.history.replaceState(null, "", "/j/NEW#new-secret");

    hook = renderSessionHook();

    expect(hook.current.sessionId).toBeNull();
    expect(hook.current.sessionSecret).toBeNull();
  });

  it("reopens signaling when a joiner never receives an offer", async () => {
    hook = renderSessionHook();

    await act(async () => {
      await hook!.current.joinSession("2MFHNJ", "secret", "Second Device", "device-2");
    });
    expect(FakeWebSocket.instances).toHaveLength(1);

    await act(async () => {
      FakeWebSocket.instances[0].open();
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(hook.current.state).toBe("DISCONNECTED");
    expect(hook.current.retryAttempt).toBe(1);
    expect(FakeWebSocket.instances[0].close).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toContain("/sessions/2MFHNJ/ws");
  });

  it("delivers encrypted file frames in arrival order despite asynchronous decryption", async () => {
    hook = renderSessionHook();
    await act(async () => { await hook!.current.joinSession("SESSION", "secret", "Device", "device-2"); });
    const receive = vi.fn();
    hook.current.setFileFrameHandler(receive);
    const rtc = rtcMocks.instances[0];
    let finishFirst!: (data: Uint8Array) => void;
    const first = new Promise<Uint8Array>((resolve) => { finishFirst = resolve; });
    cryptoMocks.decryptBytes.mockImplementationOnce(() => first)
      .mockResolvedValueOnce(encodeFileFrame({ type: "file.complete", id: "transfer" }));
    await act(async () => {
      rtc.callbacks.onMessage(new Uint8Array([1]));
      rtc.callbacks.onMessage(new Uint8Array([2]));
      await Promise.resolve();
    });
    expect(cryptoMocks.decryptBytes).toHaveBeenCalledTimes(1);
    expect(receive).not.toHaveBeenCalled();
    await act(async () => {
      finishFirst(encodeFileFrame({ type: "file.chunk", id: "transfer", index: 0, data: new Uint8Array([42]) }));
      await first;
    });
    expect(receive.mock.calls.map(([frame]) => frame.type)).toEqual(["file.chunk", "file.complete"]);
    expect(receive.mock.calls[0][0].data).toEqual(new Uint8Array([42]));
  });

  it("discards decryption completing after reset and never delivers queued old frames", async () => {
    hook = renderSessionHook();
    await act(async () => { await hook!.current.joinSession("SESSION", "secret", "Device", "device-2"); });
    const receive = vi.fn();
    hook.current.setFileFrameHandler(receive);
    let finish!: (data: Uint8Array) => void;
    const pending = new Promise<Uint8Array>((resolve) => { finish = resolve; });
    cryptoMocks.decryptBytes.mockImplementationOnce(() => pending);
    await act(async () => {
      rtcMocks.instances[0].callbacks.onMessage(new Uint8Array([1]));
      rtcMocks.instances[0].callbacks.onMessage(new Uint8Array([2]));
      await Promise.resolve();
    });
    act(() => hook!.current.reset());
    await act(async () => {
      finish(encodeFileFrame({ type: "file.complete", id: "old-transfer" }));
      await pending;
    });
    expect(receive).not.toHaveBeenCalled();
    expect(cryptoMocks.decryptBytes).toHaveBeenCalledTimes(1);
    expect(hook.current.items).toEqual([]);
    expect(hook.current.sessionId).toBeNull();
  });

  it("keeps a file transport bound to its original connection across reset and reconnect", async () => {
    hook = renderSessionHook();
    await act(async () => { await hook!.current.joinSession("SESSION", "secret", "Device", "device-2"); });
    const old = rtcMocks.instances[0];
    expect(hook.current.getFileTransport()).toBeNull();
    act(() => { old.dataChannelState = "open"; old.callbacks.onStateChange("open"); });
    const transport = hook.current.getFileTransport()!;
    expect(hook.current.getFileTransport()).toBe(transport);
    let finish!: (data: Uint8Array) => void;
    const encryption = new Promise<Uint8Array>((resolve) => { finish = resolve; });
    cryptoMocks.encryptBytes.mockImplementationOnce(() => encryption);
    const frame = { type: "file.complete" as const, id: "old-file" };
    const send = transport.send(frame, new AbortController().signal);
    act(() => hook!.current.reset());
    expect(hook.current.getFileTransport()).toBeNull();
    await act(async () => { await hook!.current.joinSession("NEXT", "secret", "Device", "device-2"); });
    const current = rtcMocks.instances[1];
    act(() => { current.dataChannelState = "open"; current.callbacks.onStateChange("open"); });
    finish(new Uint8Array([99]));
    await expect(send).resolves.toBe(false);
    await expect(transport.send(frame, new AbortController().signal)).resolves.toBe(false);
    expect(old.sendBuffered).not.toHaveBeenCalled();
    expect(current.sendBuffered).not.toHaveBeenCalled();
    await expect(hook.current.getFileTransport()!.send(frame, new AbortController().signal)).resolves.toBe(true);
    expect(current.sendBuffered).toHaveBeenCalledTimes(1);
  });

  it("permits files-only creation explicitly while rejecting blank text submission", async () => {
    hook = renderSessionHook();
    await act(async () => {
      expect(await hook!.current.createSession(" \n", "Device", "device-2"))
        .toMatchObject({ ok: false, error: { code: "blank" } });
    });
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "FILES" }), { status: 200 }));
    await act(async () => {
      expect(await hook!.current.createSession("", "Device", "device-2", true)).toEqual({ ok: true });
    });
    expect(hook.current.sessionId).toBe("FILES");
    expect(hook.current.initialText).toBe("");
    expect(hook.current.state).toBe("WAITING");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
