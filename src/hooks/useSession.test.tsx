import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSession, type UseSessionResult } from "./useSession";
import type { WebRTCCallbacks } from "../types";

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
    callbacks: WebRTCCallbacks;
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

    constructor(_servers: unknown, readonly callbacks: WebRTCCallbacks) {
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
    window.localStorage.clear();
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
    vi.restoreAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function connectWithText() {
    hook = renderSessionHook();
    await act(async () => {
      await hook!.current.joinSession("2MFHNJ", "secret", "Second Device", "device-2");
      FakeWebSocket.instances[0].open();
      const rtc = rtcMocks.instances[rtcMocks.instances.length - 1];
      rtc.dataChannelState = "open";
      rtc.callbacks.onStateChange("open");
    });
    await act(async () => {
      expect(await hook!.current.sendText("Keep this text", "Second Device", "device-2"))
        .toEqual({ ok: true });
    });
    expect(hook.current.state).toBe("CONNECTED");
    expect(hook.current.items).toHaveLength(1);
    expect(window.sessionStorage.getItem("kleepee.session.current")).not.toBeNull();
  }

  it("forgets a reset session even if beforeunload fires before React commits", async () => {
    await connectWithText();
    window.sessionStorage.setItem("unrelated-session", "keep");

    act(() => {
      hook!.current.reset();
      window.dispatchEvent(new Event("beforeunload"));
    });

    expect(hook!.current.sessionId).toBeNull();
    expect(hook!.current.items).toEqual([]);
    expect(window.sessionStorage.getItem("kleepee.session.current")).toBeNull();
    expect(window.sessionStorage.getItem("unrelated-session")).toBe("keep");
    expect(window.localStorage.getItem("kleepee.session.history")).toBeNull();

    hook!.cleanup();
    hook = null;
    expect(window.localStorage.getItem("kleepee.session.history")).toBeNull();
    expect(window.sessionStorage.getItem("kleepee.session.current")).toBeNull();
  });

  it("does not record the stale session when reset and unmount happen together", async () => {
    await connectWithText();

    act(() => {
      hook!.current.reset();
      hook!.cleanup();
      hook = null;
    });

    expect(window.localStorage.getItem("kleepee.session.history")).toBeNull();
    expect(window.sessionStorage.getItem("kleepee.session.current")).toBeNull();
  });

  it("keeps ended text available but does not restore a manually disconnected session", async () => {
    await connectWithText();
    window.sessionStorage.setItem("unrelated-session", "keep");

    act(() => hook!.current.disconnect());

    expect(hook!.current.state).toBe("DISCONNECTED");
    expect(hook!.current.terminalReason).toBe("manual");
    expect(hook!.current.items[0].content).toBe("Keep this text");
    expect(window.sessionStorage.getItem("kleepee.session.current")).toBeNull();
    expect(window.sessionStorage.getItem("unrelated-session")).toBe("keep");

    hook!.cleanup();
    hook = renderSessionHook();
    await act(async () => {
      await hook!.current.resumeStoredSession("Second Device", "device-2");
    });

    expect(hook.current.sessionId).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(window.sessionStorage.getItem("kleepee.session.current")).toBeNull();
  });

  it("retains tab recovery data after an unintentional connection loss", async () => {
    await connectWithText();

    act(() => {
      const rtc = rtcMocks.instances[rtcMocks.instances.length - 1];
      rtc.dataChannelState = "closed";
      rtc.callbacks.onStateChange("closed");
    });

    expect(hook!.current.state).toBe("DISCONNECTED");
    expect(window.sessionStorage.getItem("kleepee.session.current")).not.toBeNull();
    hook!.cleanup();
    hook = renderSessionHook();
    await act(async () => {
      await hook!.current.resumeStoredSession("Second Device", "device-2");
    });

    expect(hook.current.sessionId).toBe("2MFHNJ");
    expect(hook.current.items[0].content).toBe("Keep this text");
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("resets in-memory state when browser storage becomes unavailable", async () => {
    await connectWithText();
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });

    expect(() => act(() => {
      hook!.current.reset();
      window.dispatchEvent(new Event("beforeunload"));
    })).not.toThrow();
    expect(hook!.current.sessionId).toBeNull();
    expect(hook!.current.items).toEqual([]);
    expect(rtcMocks.instances[0].close).toHaveBeenCalled();
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
