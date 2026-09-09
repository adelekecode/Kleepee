import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSession, type UseSessionResult } from "./useSession";
import type { WebRTCCallbacks } from "../types";

const cryptoMocks = vi.hoisted(() => ({
  deriveKey: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  decryptBytes: vi.fn(),
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
    recover: ReturnType<typeof vi.fn>;
    setPeerBackground: ReturnType<typeof vi.fn>;
    dataChannelState: RTCDataChannelState | null;
    callbacks: WebRTCCallbacks;
  }>,
}));

vi.mock("../lib/crypto", () => ({
  deriveKey: cryptoMocks.deriveKey,
  encrypt: cryptoMocks.encrypt,
  decrypt: cryptoMocks.decrypt,
  decryptBytes: cryptoMocks.decryptBytes,
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
    recover = vi.fn();
    setPeerBackground = vi.fn();
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function storedSession() {
  window.sessionStorage.setItem("kleepee.session.current", JSON.stringify({
    sessionId: "2MFHNJ", sessionSecret: "secret", role: "joiner",
    peerDeviceName: null, items: [], initialText: null, initialTextSent: true,
  }));
}

describe("useSession join recovery", () => {
  let hook: ReturnType<typeof renderSessionHook> | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    cryptoMocks.deriveKey.mockResolvedValue({} as CryptoKey);
    cryptoMocks.encrypt.mockResolvedValue(new Uint8Array([1]));
    cryptoMocks.decrypt.mockResolvedValue("{}");
    cryptoMocks.decryptBytes.mockResolvedValue(new TextEncoder().encode("{}"));
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

  it.each(["status request", "key derivation"])("ignores foreground recovery while join %s is pending", async (stage) => {
    const response = deferred<Response>();
    const key = deferred<CryptoKey>();
    if (stage === "status request") vi.mocked(fetch).mockReturnValueOnce(response.promise);
    else cryptoMocks.deriveKey.mockReturnValueOnce(key.promise);
    hook = renderSessionHook();
    let joining!: ReturnType<UseSessionResult["joinSession"]>;
    await act(async () => { joining = hook!.current.joinSession("2MFHNJ", "secret", "Second Device", "device-2"); });
    expect(hook.current.isPending).toBe(true);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pageshow"));
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(rtcMocks.instances).toHaveLength(0);
    expect(hook.current.retryAttempt).toBe(0);
    expect(hook.current.isPending).toBe(true);
    await act(async () => {
      if (stage === "status request") response.resolve(new Response(JSON.stringify({ sessionState: "WAITING", deviceCount: 1 })));
      else key.resolve({} as CryptoKey);
      expect(await joining).toEqual({ ok: true });
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(rtcMocks.instances).toHaveLength(1);
    expect(hook.current.isPending).toBe(false);
  });

  it.each(["create", "join", "restore"] as const)("clears %s pending state after setup without waiting for an open data channel", async (operation) => {
    const key = deferred<CryptoKey>();
    cryptoMocks.deriveKey.mockReturnValueOnce(key.promise);
    if (operation === "restore") storedSession();
    if (operation === "create") vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "2MFHNJ" })));
    hook = renderSessionHook();
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = operation === "create"
        ? hook!.current.createSession("First text", "Second Device", "device-2")
        : operation === "join"
          ? hook!.current.joinSession("2MFHNJ", "secret", "Second Device", "device-2")
          : hook!.current.resumeStoredSession("Second Device", "device-2");
    });
    expect(hook.current.isPending).toBe(true);
    await act(async () => { key.resolve({} as CryptoKey); expect(await pending).toEqual({ ok: true }); });
    expect(hook.current.isPending).toBe(false);
    expect(hook.current.dataChannelState).not.toBe("open");
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(rtcMocks.instances).toHaveLength(1);
  });

  it("keeps operation pending false while reconnecting a lost data channel", async () => {
    await connectWithText();
    await act(async () => {
      const rtc = rtcMocks.instances[0];
      rtc.dataChannelState = "closed";
      rtc.callbacks.onStateChange("closed");
    });
    expect(hook!.current.retryAttempt).toBe(1);
    expect(hook!.current.isPending).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(hook!.current.isPending).toBe(false);
  });

  it.each(["create request", "join request", "create key", "join key", "restore key"])("ignores a stale failed %s after reset", async (operation) => {
    const response = deferred<Response>();
    const key = deferred<CryptoKey>();
    const requestPending = operation.endsWith("request");
    if (requestPending) vi.mocked(fetch).mockReturnValueOnce(response.promise);
    else {
      cryptoMocks.deriveKey.mockReturnValueOnce(key.promise);
      if (operation === "create key") vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "2MFHNJ" })));
    }
    if (operation === "restore key") storedSession();
    hook = renderSessionHook();
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = operation.startsWith("create")
        ? hook!.current.createSession("First text", "Second Device", "device-2")
        : operation.startsWith("join")
          ? hook!.current.joinSession("2MFHNJ", "secret", "Second Device", "device-2")
          : hook!.current.resumeStoredSession("Second Device", "device-2");
    });
    act(() => hook!.current.reset());
    await act(async () => {
      if (requestPending) response.reject(new Error("Late network failure"));
      else key.reject(new Error("Late key failure"));
      await pending;
    });
    expect(hook.current.sessionId).toBeNull();
    expect(hook.current.error).toBeNull();
    expect(hook.current.isPending).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(rtcMocks.instances).toHaveLength(0);
  });

  it("deduplicates concurrent joins and allows joining the same link after reset", async () => {
    const response = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(response.promise);
    hook = renderSessionHook();
    let first!: ReturnType<UseSessionResult["joinSession"]>;
    let second!: ReturnType<UseSessionResult["joinSession"]>;
    await act(async () => {
      first = hook!.current.joinSession("2MFHNJ", "secret", "Second Device", "device-2");
      second = hook!.current.joinSession("2MFHNJ", "secret", "Second Device", "device-2");
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      response.resolve(new Response(JSON.stringify({ sessionState: "WAITING", deviceCount: 1 })));
      expect(await first).toEqual({ ok: true });
      expect(await second).toEqual({ ok: true });
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(rtcMocks.instances).toHaveLength(1);
    expect(cryptoMocks.deriveKey).toHaveBeenCalledTimes(1);
    act(() => hook!.current.reset());
    await act(async () => {
      expect(await hook!.current.joinSession("2MFHNJ", "secret", "Second Device", "device-2")).toEqual({ ok: true });
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(rtcMocks.instances).toHaveLength(2);
    expect(hook.current.isPending).toBe(false);
  });

  it.each([
    ["create", "headers"], ["create", "body"], ["join", "headers"], ["join", "body"],
  ] as const)("bounds a hanging %s %s request to 20 seconds and clears pending", async (operation, stage) => {
    if (stage === "headers") vi.mocked(fetch).mockReturnValueOnce(new Promise(() => {}));
    else {
      const response = new Response("{}");
      vi.spyOn(response, "json").mockReturnValueOnce(new Promise(() => {}));
      vi.mocked(fetch).mockResolvedValueOnce(response);
    }
    hook = renderSessionHook();
    const finished = vi.fn();
    await act(async () => {
      const pending = operation === "create"
        ? hook!.current.createSession("Text to keep", "Second Device", "device-2")
        : hook!.current.joinSession("2MFHNJ", "secret", "Second Device", "device-2");
      void pending.then(finished);
    });
    expect(hook.current.isPending).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(19_999); });
    expect(finished).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(hook.current.isPending).toBe(false);
    expect(hook.current.error).not.toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(rtcMocks.instances).toHaveLength(0);
  });

  it.each(["create", "join"] as const)("reset settles a %s request even when fetch ignores abort and never resolves", async (operation) => {
    vi.mocked(fetch).mockReturnValueOnce(new Promise(() => {}));
    hook = renderSessionHook();
    const finished = vi.fn();
    await act(async () => {
      const pending = operation === "create"
        ? hook!.current.createSession("Text", "Second Device", "device-2")
        : hook!.current.joinSession("2MFHNJ", "secret", "Second Device", "device-2");
      void pending.then(finished);
    });
    expect(finished).not.toHaveBeenCalled();
    await act(async () => { hook!.current.reset(); });
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(hook.current.isPending).toBe(false);
    expect(hook.current.error).toBeNull();
    expect(hook.current.sessionId).toBeNull();
  });

  it("does not replace the initiator's negotiating connection on foreground with open signaling", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "2MFHNJ" })));
    hook = renderSessionHook();
    await act(async () => {
      await hook!.current.createSession("First text", "Second Device", "device-2");
      FakeWebSocket.instances[0].open();
      rtcMocks.instances[0].dataChannelState = "connecting";
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pageshow"));
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(rtcMocks.instances).toHaveLength(1);
    expect(rtcMocks.instances[0].close).not.toHaveBeenCalled();
    expect(rtcMocks.instances[0].createOffer).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(hook.current.retryAttempt).toBe(0);
    expect(hook.current.isPending).toBe(false);
  });

  it("cannot resurrect transports after a rejected join when pageshow or online fires", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 404 }));
    hook = renderSessionHook();
    await act(async () => {
      expect(await hook!.current.joinSession("2MFHNJ", "secret", "Second Device", "device-2")).toMatchObject({ ok: false });
      window.dispatchEvent(new Event("pageshow"));
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(rtcMocks.instances).toHaveLength(0);
    expect(hook.current.isPending).toBe(false);
    expect(hook.current.error?.code).toBe("session_not_found");
  });

  it.each(["reset", "new session"] as const)("never sends stale encrypted text after %s", async (operation) => {
    await connectWithText();
    const oldRtc = rtcMocks.instances[0];
    oldRtc.send.mockClear();
    const encryption = deferred<Uint8Array>();
    const staleBytes = new Uint8Array([17, 29, 43]);
    cryptoMocks.encrypt.mockReturnValueOnce(encryption.promise);
    let pending!: ReturnType<UseSessionResult["sendText"]>;
    await act(async () => { pending = hook!.current.sendText("Stale draft", "Second Device", "device-2"); });
    await act(async () => {
      hook!.current.reset();
      if (operation === "new session") {
        await hook!.current.joinSession("NEW456", "new-secret", "Second Device", "device-2");
        FakeWebSocket.instances[1].open();
        const freshRtc = rtcMocks.instances[1];
        freshRtc.dataChannelState = "open";
        freshRtc.callbacks.onStateChange("open");
      }
    });
    await act(async () => {
      encryption.resolve(staleBytes);
      expect(await pending).toMatchObject({ ok: false });
    });
    expect(oldRtc.send).not.toHaveBeenCalledWith(staleBytes);
    if (operation === "new session") {
      expect(rtcMocks.instances[1].send).not.toHaveBeenCalledWith(staleBytes);
      expect(hook!.current.sessionId).toBe("NEW456");
    }
    expect(hook!.current.items).toEqual([]);
    expect(hook!.current.error).toBeNull();
  });

  it("keeps an open data channel connected while the page is hidden", async () => {
    await connectWithText();
    const rtc = rtcMocks.instances[0];
    await act(async () => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(hook!.current.state).toBe("CONNECTED");
    expect(rtc.close).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(cryptoMocks.encrypt).toHaveBeenCalledWith(expect.anything(), JSON.stringify({ type: "presence", hidden: true }));
  });

  it.each(["close", "error"])("repairs signaling after websocket %s without interrupting text", async (event) => {
    await connectWithText();
    const rtc = rtcMocks.instances[0];
    const ws = FakeWebSocket.instances[0];
    await act(async () => {
      if (event === "close") {
        ws.readyState = FakeWebSocket.CLOSED;
        ws.onclose?.({ code: 1006 } as CloseEvent);
      } else ws.onerror?.();
      expect(await hook!.current.sendText("Still connected", "Second Device", "device-2")).toEqual({ ok: true });
    });
    expect(hook!.current.state).toBe("CONNECTED");
    expect(hook!.current.items.at(-1)?.content).toBe("Still connected");
    expect(rtc.close).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(rtcMocks.instances).toHaveLength(1);
    expect(rtc.close).not.toHaveBeenCalled();
    expect(hook!.current.state).toBe("CONNECTED");
  });

  it("ignores signaling peer leave/join churn while the data channel is open", async () => {
    await connectWithText();
    const rtc = rtcMocks.instances[0];
    await act(async () => {
      FakeWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: "peer.leave" }) } as MessageEvent);
      FakeWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: "peer.join", deviceName: "Returned Device" }) } as MessageEvent);
    });
    expect(hook!.current.state).toBe("CONNECTED");
    expect(hook!.current.peerDeviceName).toBe("Returned Device");
    expect(rtcMocks.instances).toHaveLength(1);
    expect(rtc.close).not.toHaveBeenCalled();
    expect(rtc.createOffer).not.toHaveBeenCalled();
  });

  it.each(["reset", "disconnect"] as const)("never reconnects a manually %s session on foreground or online events", async (action) => {
    await connectWithText();
    const rtc = rtcMocks.instances[0];
    await act(async () => {
      hook!.current[action]();
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("resume"));
      window.dispatchEvent(new Event("pageshow"));
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(rtcMocks.instances).toHaveLength(1);
    expect(rtc.recover).not.toHaveBeenCalled();
    expect(hook!.current.state).not.toBe("CONNECTED");
  });

  it("repairs only closed signaling when an open data channel returns to foreground", async () => {
    await connectWithText();
    const rtc = rtcMocks.instances[0];
    FakeWebSocket.instances[0].readyState = FakeWebSocket.CLOSED;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pageshow"));
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(rtc.recover).toHaveBeenCalled();
    expect(rtc.close).not.toHaveBeenCalled();
    expect(rtcMocks.instances).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(hook!.current.state).toBe("CONNECTED");
  });

  it("uses encrypted peer presence to suspend peer deadlines without adding feed items", async () => {
    await connectWithText();
    const rtc = rtcMocks.instances[0];
    for (const hidden of [true, false]) {
      cryptoMocks.decryptBytes.mockResolvedValueOnce(new TextEncoder().encode(JSON.stringify({ type: "presence", hidden })));
      await act(async () => { rtc.callbacks.onMessage(new Uint8Array([5])); });
      expect(hook!.current.peerBackground).toBe(hidden);
      expect(rtc.setPeerBackground).toHaveBeenLastCalledWith(hidden);
      expect(hook!.current.items).toHaveLength(1);
      expect(hook!.current.state).toBe("CONNECTED");
    }
  });

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
