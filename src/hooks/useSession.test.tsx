import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSession, type UseSessionResult } from "./useSession";

const cryptoMocks = vi.hoisted(() => ({
  deriveKey: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
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
    dataChannelState: RTCDataChannelState | null;
  }>,
}));

vi.mock("../lib/crypto", () => ({
  deriveKey: cryptoMocks.deriveKey,
  encrypt: cryptoMocks.encrypt,
  decrypt: cryptoMocks.decrypt,
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
    dataChannelState: RTCDataChannelState | null = null;

    constructor() {
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
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
    cryptoMocks.deriveKey.mockResolvedValue({} as CryptoKey);
    cryptoMocks.encrypt.mockResolvedValue(new Uint8Array([1]));
    cryptoMocks.decrypt.mockResolvedValue("{}");
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
});
