import { useEffect, useReducer, useRef } from "react";
import { WebRTCManager } from "../lib/webrtc";
import { createIceServerLoader } from "../lib/iceServers";
import { deriveKey, encrypt, decryptBytes, encryptBytes, generateSessionSecret } from "../lib/crypto";
import { recordSession } from "../lib/sessionHistory";
import { CHUNK_SIZE, FRAME_OVERHEAD, decodeFileFrame, encodeFileFrame, isFileFrame } from "../lib/fileTransfer";
import type { ClientMessage, ServerMessage, SessionState, TextItem } from "../types";
import type { FileFrame, FileTransport } from "../types/files";

const WORKER_BASE =
  typeof import.meta.env !== "undefined" && import.meta.env.VITE_WORKER_URL
    ? (import.meta.env.VITE_WORKER_URL as string)
    : "https://kleepee-worker.adelekecode.dev";

const MAX_RETRIES: number | null = null;
const BACKOFF_DELAYS = [2000, 4000, 8000, 15000];
const MAX_BYTES = 65536;
const SESSION_STORAGE_KEY = "kleepee.session.current";
const HEARTBEAT_INTERVAL_MS = 25 * 1000;
const JOIN_OFFER_TIMEOUT_MS = 15 * 1000;

export type SessionErrorCode =
  | "blank"
  | "too_large"
  | "file_too_large"
  | "create_failed"
  | "join_invalid"
  | "session_full"
  | "session_expired"
  | "session_not_found"
  | "not_connected"
  | "connection_failed"
  | "send_failed";

export type TerminalDisconnectReason =
  | "manual"
  | "retries_exhausted"
  | "expired"
  | "peer_left"
  | "network"
  | null;

export interface SessionError {
  code: SessionErrorCode;
  message: string;
  status?: number;
}

export type SessionActionResult =
  | { ok: true }
  | { ok: false; error: SessionError };

interface SessionStore {
  state: SessionState;
  sessionId: string | null;
  sessionSecret: string | null;
  role: "initiator" | "joiner" | null;
  peerDeviceName: string | null;
  items: TextItem[];
  initialText: string | null;
  initialTextSent: boolean;
  error: SessionError | null;
  isPending: boolean;
  retryAttempt: number;
  maxRetries: number | null;
  dataChannelState: RTCDataChannelState | null;
  terminalReason: TerminalDisconnectReason;
}

const emptyStore: SessionStore = {
  state: "WAITING",
  sessionId: null,
  sessionSecret: null,
  role: null,
  peerDeviceName: null,
  items: [],
  initialText: null,
  initialTextSent: false,
  error: null,
  isPending: false,
  retryAttempt: 0,
  maxRetries: MAX_RETRIES,
  dataChannelState: null,
  terminalReason: null,
};

interface StoredSession {
  sessionId: string;
  sessionSecret: string;
  role: "initiator" | "joiner";
  peerDeviceName: string | null;
  items: TextItem[];
  initialText: string | null;
  initialTextSent: boolean;
}

function readStoredSession(): StoredSession | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof parsed.sessionId !== "string" ||
      typeof parsed.sessionSecret !== "string" ||
      (parsed.role !== "initiator" && parsed.role !== "joiner")
    ) {
      return null;
    }

    return {
      sessionId: parsed.sessionId,
      sessionSecret: parsed.sessionSecret,
      role: parsed.role,
      peerDeviceName: typeof parsed.peerDeviceName === "string" ? parsed.peerDeviceName : null,
      items: Array.isArray(parsed.items) ? parsed.items.filter(isValidTextItem) : [],
      initialText: typeof parsed.initialText === "string" ? parsed.initialText : null,
      initialTextSent: parsed.initialTextSent === true,
    };
  } catch {
    return null;
  }
}

function writeStoredSession(store: SessionStore): void {
  if (typeof window === "undefined") return;
  try {
    const ended = store.terminalReason === "manual" || store.terminalReason === "retries_exhausted";
    if (!store.sessionId || !store.sessionSecret || !store.role || store.state === "EXPIRED" || ended) {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
      return;
    }
    const stored: StoredSession = {
      sessionId: store.sessionId,
      sessionSecret: store.sessionSecret,
      role: store.role,
      peerDeviceName: store.peerDeviceName,
      items: store.items,
      initialText: store.initialText,
      initialTextSent: store.initialTextSent,
    };
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // A blocked or full browser store must not prevent sending or resetting.
  }
}

function clearStoredSession(): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch { /* storage unavailable */ }
}

function getInitialStore(): SessionStore {
  // An explicit join link takes precedence over this tab's previous session.
  if (typeof window !== "undefined" && window.location.pathname.startsWith("/j/")) return emptyStore;
  const stored = readStoredSession();
  if (!stored) return emptyStore;

  return {
    ...emptyStore,
    state: stored.role === "initiator" && !stored.initialTextSent ? "WAITING" : "CONNECTING",
    sessionId: stored.sessionId,
    sessionSecret: stored.sessionSecret,
    role: stored.role,
    peerDeviceName: stored.peerDeviceName,
    items: stored.items,
    initialText: stored.initialText,
    initialTextSent: stored.initialTextSent,
    isPending: true,
  };
}

type Action =
  | { type: "PENDING"; isPending: boolean }
  | { type: "SESSION_CREATED"; sessionId: string; sessionSecret: string; initialText: string }
  | { type: "SESSION_JOINED"; sessionId: string; sessionSecret: string }
  | { type: "SESSION_RESTORED"; stored: StoredSession }
  | { type: "PEER_JOINED"; peerDeviceName: string }
  | { type: "CONNECTING" }
  | { type: "CONNECTED" }
  | { type: "RECONNECTING"; retryAttempt: number; reason: TerminalDisconnectReason }
  | { type: "DISCONNECTED"; reason: TerminalDisconnectReason }
  | { type: "EXPIRED" }
  | { type: "CHANNEL_STATE"; dataChannelState: RTCDataChannelState | null }
  | { type: "ITEM_RECEIVED"; item: TextItem }
  | { type: "INITIAL_TEXT_SENT" }
  | { type: "ERROR"; error: SessionError }
  | { type: "CLEAR_ERROR" }
  | { type: "RESET" };

function reducer(store: SessionStore, action: Action): SessionStore {
  switch (action.type) {
    case "PENDING":
      return { ...store, isPending: action.isPending };
    case "SESSION_CREATED":
      return {
        ...emptyStore,
        state: "WAITING",
        sessionId: action.sessionId,
        sessionSecret: action.sessionSecret,
        role: "initiator",
        initialText: action.initialText,
        initialTextSent: false,
      };
    case "SESSION_JOINED":
      return {
        ...emptyStore,
        state: "CONNECTING",
        sessionId: action.sessionId,
        sessionSecret: action.sessionSecret,
        role: "joiner",
      };
    case "SESSION_RESTORED":
      return {
        ...emptyStore,
        state: action.stored.role === "initiator" && !action.stored.initialTextSent ? "WAITING" : "CONNECTING",
        sessionId: action.stored.sessionId,
        sessionSecret: action.stored.sessionSecret,
        role: action.stored.role,
        peerDeviceName: action.stored.peerDeviceName,
        items: action.stored.items,
        initialText: action.stored.initialText,
        initialTextSent: action.stored.initialTextSent,
        isPending: true,
      };
    case "PEER_JOINED":
      return { ...store, peerDeviceName: action.peerDeviceName };
    case "CONNECTING":
      return { ...store, state: "CONNECTING", terminalReason: null };
    case "CONNECTED":
      return {
        ...store,
        state: "CONNECTED",
        error: null,
        isPending: false,
        retryAttempt: 0,
        terminalReason: null,
      };
    case "RECONNECTING":
      return {
        ...store,
        state: "DISCONNECTED",
        retryAttempt: action.retryAttempt,
        terminalReason: action.reason,
      };
    case "DISCONNECTED":
      return {
        ...store,
        state: "DISCONNECTED",
        isPending: false,
        dataChannelState: null,
        terminalReason: action.reason,
      };
    case "EXPIRED":
      return {
        ...store,
        state: "EXPIRED",
        isPending: false,
        dataChannelState: null,
        terminalReason: "expired",
      };
    case "CHANNEL_STATE":
      return { ...store, dataChannelState: action.dataChannelState };
    case "ITEM_RECEIVED":
      return { ...store, items: [...store.items, action.item] };
    case "INITIAL_TEXT_SENT":
      return { ...store, initialTextSent: true };
    case "ERROR":
      return { ...store, error: action.error, isPending: false };
    case "CLEAR_ERROR":
      return { ...store, error: null };
    case "RESET":
      return { ...emptyStore };
  }
}

export interface UseSessionResult {
  state: SessionState;
  sessionId: string | null;
  sessionSecret: string | null;
  role: "initiator" | "joiner" | null;
  peerDeviceName: string | null;
  items: TextItem[];
  initialText: string | null;
  error: SessionError | null;
  isPending: boolean;
  retryAttempt: number;
  maxRetries: number | null;
  dataChannelState: RTCDataChannelState | null;
  terminalReason: TerminalDisconnectReason;
  resumeStoredSession: (deviceName: string, deviceId: string) => Promise<SessionActionResult>;
  createSession: (initialText: string, deviceName: string, deviceId: string, allowEmpty?: boolean) => Promise<SessionActionResult>;
  joinSession: (
    sessionId: string,
    sessionSecret: string,
    deviceName: string,
    deviceId: string,
  ) => Promise<SessionActionResult>;
  sendText: (text: string, deviceName: string, deviceId: string) => Promise<SessionActionResult>;
  disconnect: () => void;
  reset: () => void;
  clearError: () => void;
  /** Register a handler that receives decrypted file frames from the DataChannel */
  setFileFrameHandler: (handler: ((frame: unknown) => void) | null) => void;
  getFileTransport: () => FileTransport | null;
}

function makeError(code: SessionErrorCode, message: string, status?: number): SessionError {
  return { code, message, status };
}

function cancelledOperation(): SessionActionResult {
  return { ok: false, error: makeError("connection_failed", "Session changed before connecting.") };
}

function validateText(text: string): SessionError | null {
  if (text.trim().length === 0) {
    return makeError("blank", "Add some text first.");
  }

  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) {
    return makeError("too_large", "That message is too large to send.");
  }

  return null;
}

function isValidTextItem(value: unknown): value is TextItem {
  if (!value || typeof value !== "object") return false;

  const item = value as Partial<TextItem>;
  return (
    item.type === "text" &&
    typeof item.id === "string" &&
    typeof item.senderId === "string" &&
    typeof item.senderName === "string" &&
    typeof item.timestamp === "number" &&
    Number.isFinite(item.timestamp) &&
    typeof item.content === "string" &&
    item.content.length > 0 &&
    new TextEncoder().encode(item.content).byteLength <= MAX_BYTES
  );
}

function mapJoinStatus(status: number): SessionError {
  if (status === 409) {
    return makeError("session_full", "This session already has two devices.", status);
  }

  if (status === 410) {
    return makeError("session_expired", "This session has expired.", status);
  }

  if (status === 404) {
    return makeError("session_not_found", "Session not found.", status);
  }

  return makeError("connection_failed", "Could not connect to this session.", status);
}

export function useSession(): UseSessionResult {
  const [store, dispatch] = useReducer(reducer, undefined, getInitialStore);

  const wsRef = useRef<WebSocket | null>(null);
  const rtcRef = useRef<WebRTCManager | null>(null);
  const iceLoaderRef = useRef<{ key: string; load: () => Promise<RTCIceServer[]> } | null>(null);
  const cryptoKeyRef = useRef<CryptoKey | null>(null);
  const initialTextRef = useRef<string | null>(null);
  const initialTextSentRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);
  const operationIdRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  const sessionSecretRef = useRef<string | null>(null);
  const roleRef = useRef<"initiator" | "joiner" | null>(null);
  const deviceNameRef = useRef("");
  const deviceIdRef = useRef("");
  const dataChannelStateRef = useRef<RTCDataChannelState | null>(null);
  const intentionalCloseRef = useRef(false);
  const resumedRef = useRef(false);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const joinOfferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionStartedAtRef = useRef<number | null>(null);
  // Ref to always have the latest store snapshot for history recording without
  // creating stale closures inside imperative functions.
  const historySuppressedRef = useRef(false);
  const storeRef = useRef(store);
  storeRef.current = store;
  // External handler for file frames — set by the consumer (ConnectedPage via context)
  const onFileFrameRef = useRef<((frame: unknown) => void) | null>(null);
  const fileTransportRef = useRef<{ manager: WebRTCManager; transport: FileTransport } | null>(null);

  function restoreRefs(stored: StoredSession, deviceName: string, deviceId: string) {
    historySuppressedRef.current = false;
    deviceNameRef.current = deviceName;
    deviceIdRef.current = deviceId;
    sessionIdRef.current = stored.sessionId;
    sessionSecretRef.current = stored.sessionSecret;
    roleRef.current = stored.role;
    initialTextRef.current = stored.initialText;
    initialTextSentRef.current = stored.initialTextSent;
  }

  function clearRetryTimer() {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }

  function clearHeartbeatTimer() {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }

  function clearJoinOfferTimer() {
    if (joinOfferTimerRef.current) {
      clearTimeout(joinOfferTimerRef.current);
      joinOfferTimerRef.current = null;
    }
  }

  function startHeartbeat() {
    clearHeartbeatTimer();

    heartbeatTimerRef.current = setInterval(() => {
      if (!cryptoKeyRef.current || !rtcRef.current || rtcRef.current.dataChannelState !== "open") {
        return;
      }

      void encrypt(
        cryptoKeyRef.current,
        JSON.stringify({ type: "ping", timestamp: Date.now() }),
      ).then((payload) => {
        rtcRef.current?.send(payload);
      }).catch(() => {
        /* ignore heartbeat failures; normal reconnect handles channel close */
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  function closeTransports(clearKey: boolean) {
    clearRetryTimer();
    clearHeartbeatTimer();
    clearJoinOfferTimer();

    try {
      wsRef.current?.close();
    } catch {
      /* ignore */
    }

    try {
      rtcRef.current?.close();
    } catch {
      /* ignore */
    }

    wsRef.current = null;
    rtcRef.current = null;
    dataChannelStateRef.current = null;

    if (clearKey) {
      cryptoKeyRef.current = null;
    }
  }

  async function transmitText(text: string, deviceName: string, deviceId: string): Promise<SessionActionResult> {
    const validationError = validateText(text);
    if (validationError) {
      dispatch({ type: "ERROR", error: validationError });
      return { ok: false, error: validationError };
    }

    if (!cryptoKeyRef.current || !rtcRef.current || rtcRef.current.dataChannelState !== "open") {
      const error = makeError("not_connected", "Not connected.");
      dispatch({ type: "ERROR", error });
      return { ok: false, error };
    }

    const item: TextItem = {
      id: crypto.randomUUID(),
      type: "text",
      senderId: deviceId,
      senderName: deviceName,
      timestamp: Date.now(),
      content: text,
    };

    try {
      const payload = await encrypt(cryptoKeyRef.current, JSON.stringify(item));
      const sent = rtcRef.current.send(payload);

      if (!sent) {
        const error = makeError("send_failed", "Could not send that text. Try again.");
        dispatch({ type: "ERROR", error });
        return { ok: false, error };
      }

      dispatch({ type: "ITEM_RECEIVED", item });
      dispatch({ type: "CLEAR_ERROR" });
      return { ok: true };
    } catch {
      const error = makeError("send_failed", "Could not send that text. Try again.");
      dispatch({ type: "ERROR", error });
      return { ok: false, error };
    }
  }

  function scheduleReconnect(reason: TerminalDisconnectReason) {
    if (intentionalCloseRef.current || !sessionIdRef.current || !sessionSecretRef.current) {
      return;
    }

    if (MAX_RETRIES !== null && retryCountRef.current >= MAX_RETRIES) {
      const error = makeError("connection_failed", "Could not reconnect to this session.");
      dispatch({ type: "ERROR", error });
      dispatch({ type: "DISCONNECTED", reason: "retries_exhausted" });
      return;
    }

    const retryAttempt = retryCountRef.current + 1;
    const delay = BACKOFF_DELAYS[retryCountRef.current] ?? BACKOFF_DELAYS[BACKOFF_DELAYS.length - 1];
    retryCountRef.current = retryAttempt;
    operationIdRef.current += 1;
    const operationId = operationIdRef.current;

    dispatch({ type: "CHANNEL_STATE", dataChannelState: null });
    dispatch({ type: "RECONNECTING", retryAttempt, reason });

    closeTransports(false);
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      if (operationId !== operationIdRef.current || !sessionIdRef.current) return;
      setupWebRTC(operationId);
      openWebSocket(sessionIdRef.current, operationId);
    }, delay);
  }

  function sendSignal(message: ClientMessage) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }

  function scheduleRTCReconnect() {
    if (intentionalCloseRef.current || retryTimerRef.current) return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      scheduleReconnect("network");
      return;
    }

    // Keep signaling attached while rebuilding the direct connection. Closing
    // both sockets here makes each peer's departure restart the other peer.
    clearHeartbeatTimer();
    rtcRef.current?.close();
    rtcRef.current = null;
    dataChannelStateRef.current = null;
    const attempt = ++retryCountRef.current;
    const operationId = operationIdRef.current;
    dispatch({ type: "CHANNEL_STATE", dataChannelState: null });
    dispatch({ type: "RECONNECTING", retryAttempt: attempt, reason: "network" });
    retryTimerRef.current = setTimeout(async () => {
      retryTimerRef.current = null;
      if (operationId !== operationIdRef.current || intentionalCloseRef.current) return;
      const rtc = setupWebRTC(operationId);
      if (roleRef.current === "initiator") {
        try {
          const offer = await rtc.createOffer();
          if (rtcRef.current === rtc && operationId === operationIdRef.current) {
            sendSignal({ type: "signal.offer", offer });
          }
        } catch {
          if (rtcRef.current === rtc) scheduleRTCReconnect();
        }
      }
    }, BACKOFF_DELAYS[attempt - 1] ?? BACKOFF_DELAYS[BACKOFF_DELAYS.length - 1]);
  }

  function startJoinOfferTimer(operationId: number, ws: WebSocket) {
    clearJoinOfferTimer();
    joinOfferTimerRef.current = setTimeout(() => {
      joinOfferTimerRef.current = null;
      if (
        operationId !== operationIdRef.current ||
        wsRef.current !== ws ||
        roleRef.current !== "joiner" ||
        dataChannelStateRef.current === "open" ||
        intentionalCloseRef.current
      ) {
        return;
      }

      scheduleReconnect("network");
    }, JOIN_OFFER_TIMEOUT_MS);
  }

  function setupWebRTC(operationId = operationIdRef.current): WebRTCManager {
    rtcRef.current?.close();

    const sessionId = sessionIdRef.current!;
    const key = `${sessionId}:${deviceIdRef.current}`;
    if (iceLoaderRef.current?.key !== key) {
      iceLoaderRef.current = {
        key,
        load: createIceServerLoader(WORKER_BASE, sessionId, deviceIdRef.current),
      };
    }
    let receiveQueue = Promise.resolve();
    const loadIce = iceLoaderRef.current.load;
    const manager = new WebRTCManager(async () => {
      const servers = await loadIce();
      if (import.meta.env.VITE_ALLOW_TURN_RELAY === "true") return servers;
      // Direct-only by default: a TURN candidate would relay file ciphertext.
      return servers.flatMap((server) => {
        const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
          .filter((url) => url.startsWith("stun:"));
        return urls.length ? [{ urls }] : [];
      });
    }, {
      onMessage: (data: Uint8Array) => {
        receiveQueue = receiveQueue.then(async () => {
        if (operationId !== operationIdRef.current || rtcRef.current !== manager || !cryptoKeyRef.current) return;

        try {
          const plain = await decryptBytes(cryptoKeyRef.current, data);
          if (operationId !== operationIdRef.current || rtcRef.current !== manager) return;
          const fileFrame = decodeFileFrame(plain);
          if (fileFrame !== null) {
            onFileFrameRef.current?.(fileFrame);
            return;
          }
          const parsed = JSON.parse(new TextDecoder().decode(plain)) as unknown;

          if (
            parsed &&
            typeof parsed === "object" &&
            (parsed as { type?: unknown }).type === "ping"
          ) {
            return;
          }

          // Route file frames to the external handler
          if (isFileFrame(parsed)) {
            onFileFrameRef.current?.(parsed);
            return;
          }

          if (isValidTextItem(parsed)) {
            dispatch({ type: "ITEM_RECEIVED", item: parsed });
          } else {
            console.warn("Discarded malformed text item");
          }
        } catch {
          console.warn("Discarded unreadable encrypted message");
        }
        });
      },
      onStateChange: (channelState: RTCDataChannelState) => {
        if (operationId !== operationIdRef.current || rtcRef.current !== manager) return;

        dataChannelStateRef.current = channelState;
        dispatch({ type: "CHANNEL_STATE", dataChannelState: channelState });

        if (channelState === "open") {
          retryCountRef.current = 0;
          sessionStartedAtRef.current = sessionStartedAtRef.current ?? Date.now();
          startHeartbeat();
          dispatch({ type: "CONNECTED" });

          if (roleRef.current === "initiator" && initialTextRef.current && !initialTextSentRef.current) {
            void transmitText(initialTextRef.current, deviceNameRef.current, deviceIdRef.current).then((result) => {
              if (result.ok) {
                initialTextSentRef.current = true;
                dispatch({ type: "INITIAL_TEXT_SENT" });
              }
            });
          }
          return;
        }

        if (channelState === "closed") {
          clearHeartbeatTimer();
          scheduleRTCReconnect();
        }
      },
      onIceCandidate: (candidate: RTCIceCandidate) => {
        if (operationId !== operationIdRef.current || rtcRef.current !== manager) return;
        sendSignal({ type: "signal.ice", candidate: candidate.toJSON() });
      },
      onOffer: () => {
        /* handled by caller */
      },
      onAnswer: () => {
        /* handled by caller */
      },
    });

    rtcRef.current = manager;
    return manager;
  }

  function openWebSocket(sessionId: string, operationId = operationIdRef.current) {
    try {
      wsRef.current?.close();
    } catch {
      /* ignore */
    }

    const wsBase = WORKER_BASE.replace(/^http/, "ws");
    const deviceName = encodeURIComponent(deviceNameRef.current || "Unknown Device");
    const deviceId = encodeURIComponent(deviceIdRef.current || crypto.randomUUID());
    const ws = new WebSocket(`${wsBase}/sessions/${encodeURIComponent(sessionId)}/ws?deviceName=${deviceName}&deviceId=${deviceId}`);
    wsRef.current = ws;

    let messageQueue = Promise.resolve();
    ws.onopen = () => {
      if (operationId !== operationIdRef.current || wsRef.current !== ws) return;
      if (roleRef.current === "joiner") startJoinOfferTimer(operationId, ws);
    };

    ws.onmessage = (event: MessageEvent) => {
      // SDP operations are asynchronous; preserve wire order for SDP and ICE.
      messageQueue = messageQueue.then(() => handleMessage(event));
    };

    async function handleMessage(event: MessageEvent) {
      if (operationId !== operationIdRef.current || wsRef.current !== ws) return;

      let message: ServerMessage;
      try {
        message = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }

      try {
        switch (message.type) {
          case "peer.join": {
            clearRetryTimer();
            const rtc = setupWebRTC(operationId);
            dispatch({ type: "PEER_JOINED", peerDeviceName: message.deviceName });
            dispatch({ type: "CONNECTING" });

            if (roleRef.current === "initiator") {
              const offer = await rtc.createOffer();
              if (rtcRef.current === rtc && operationId === operationIdRef.current) {
                sendSignal({ type: "signal.offer", offer });
              }
            }
            break;
          }
          case "signal.offer": {
            if (roleRef.current === "joiner") {
              clearJoinOfferTimer();
              clearRetryTimer();
              const rtc = rtcRef.current ?? setupWebRTC(operationId);
              dispatch({ type: "CONNECTING" });
              const answer = await rtc.handleOffer(message.offer);
              if (rtcRef.current === rtc && operationId === operationIdRef.current) {
                sendSignal({ type: "signal.answer", answer });
              }
            }
            break;
          }
          case "signal.answer": {
            await rtcRef.current?.handleAnswer(message.answer);
            break;
          }
          case "signal.ice": {
            await (rtcRef.current ?? setupWebRTC(operationId)).addIceCandidate(message.candidate);
            break;
          }
          case "session.expired": {
            operationIdRef.current += 1;
            intentionalCloseRef.current = true;
            clearJoinOfferTimer();
            saveToHistory();
            dispatch({ type: "EXPIRED" });
            closeTransports(true);
            break;
          }
          case "peer.leave": {
            clearRetryTimer();
            clearHeartbeatTimer();
            clearJoinOfferTimer();
            rtcRef.current?.close();
            rtcRef.current = null;
            dataChannelStateRef.current = null;
            dispatch({ type: "CHANNEL_STATE", dataChannelState: null });
            dispatch({ type: "DISCONNECTED", reason: "peer_left" });
            break;
          }
        }
      } catch (error) {
        console.warn("Kleepee signaling failed", error);
        if (operationId === operationIdRef.current) scheduleRTCReconnect();
      }
    }

    ws.onerror = () => {
      if (operationId !== operationIdRef.current || wsRef.current !== ws) return;
      clearJoinOfferTimer();
      scheduleReconnect("network");
    };

    ws.onclose = (event: CloseEvent) => {
      if (operationId !== operationIdRef.current || wsRef.current !== ws || intentionalCloseRef.current) return;
      clearJoinOfferTimer();

      if (event.code === 4410) {
        operationIdRef.current += 1;
        saveToHistory();
        dispatch({ type: "EXPIRED" });
        closeTransports(true);
        return;
      }

      if (event.code === 4409) {
        const error = makeError("session_full", "This session already has two devices.", 409);
        dispatch({ type: "ERROR", error });
        dispatch({ type: "DISCONNECTED", reason: "network" });
        return;
      }

      scheduleReconnect("network");
    };
  }

  async function checkJoinable(sessionId: string): Promise<SessionActionResult> {
    try {
      const response = await fetch(`${WORKER_BASE}/sessions/${encodeURIComponent(sessionId)}?deviceId=${encodeURIComponent(deviceIdRef.current)}`);

      if (!response.ok) {
        const error = mapJoinStatus(response.status);
        return { ok: false, error };
      }

      const body = (await response.json().catch(() => null)) as {
        sessionState?: SessionState;
        deviceCount?: number;
        canJoin?: boolean;
      } | null;

      if (body?.sessionState === "EXPIRED") {
        const error = makeError("session_expired", "This session has expired.", 410);
        return { ok: false, error };
      }

      if (body?.canJoin === false || (body?.canJoin !== true && typeof body?.deviceCount === "number" && body.deviceCount >= 2)) {
        const error = makeError("session_full", "This session already has two devices.", 409);
        return { ok: false, error };
      }

      if (typeof body?.deviceCount === "number" && body.deviceCount === 0) {
        const error = makeError("session_not_found", "Session not found.", 404);
        return { ok: false, error };
      }

      return { ok: true };
    } catch {
      return { ok: true };
    }
  }

  async function createSession(
    initialText: string,
    deviceName: string,
    deviceId: string,
    allowEmpty = false,
  ): Promise<SessionActionResult> {
    const validationError = allowEmpty && !initialText.trim() ? null : validateText(initialText);
    if (validationError) {
      dispatch({ type: "ERROR", error: validationError });
      return { ok: false, error: validationError };
    }

    operationIdRef.current += 1;
    const operationId = operationIdRef.current;
    intentionalCloseRef.current = true;
    closeTransports(true);
    intentionalCloseRef.current = false;
    retryCountRef.current = 0;
    initialTextSentRef.current = false;
    deviceNameRef.current = deviceName;
    deviceIdRef.current = deviceId;
    initialTextRef.current = initialText;
    dispatch({ type: "PENDING", isPending: true });

    try {
      const response = await fetch(`${WORKER_BASE}/sessions`, { method: "POST" });

      if (!response.ok) {
        const error = makeError("create_failed", "Could not create a session.", response.status);
        dispatch({ type: "ERROR", error });
        return { ok: false, error };
      }

      const { sessionId } = (await response.json()) as { sessionId: string };
      const sessionSecret = generateSessionSecret();
      const key = await deriveKey(sessionSecret);
      if (operationId !== operationIdRef.current) return cancelledOperation();
      cryptoKeyRef.current = key;

      sessionIdRef.current = sessionId;
      sessionSecretRef.current = sessionSecret;
      roleRef.current = "initiator";
      sessionStartedAtRef.current = null;
      historySuppressedRef.current = false;

      dispatch({ type: "SESSION_CREATED", sessionId, sessionSecret, initialText });
      setupWebRTC(operationId);
      openWebSocket(sessionId, operationId);
      return { ok: true };
    } catch {
      const error = makeError("create_failed", "Could not create a session.");
      dispatch({ type: "ERROR", error });
      return { ok: false, error };
    }
  }

  async function joinSession(
    sessionId: string,
    sessionSecret: string,
    deviceName: string,
    deviceId: string,
  ): Promise<SessionActionResult> {
    if (!sessionId || !sessionSecret) {
      const error = makeError("join_invalid", "This link is missing session details.");
      dispatch({ type: "ERROR", error });
      return { ok: false, error };
    }

    operationIdRef.current += 1;
    const operationId = operationIdRef.current;
    intentionalCloseRef.current = true;
    closeTransports(true);
    intentionalCloseRef.current = false;
    retryCountRef.current = 0;
    initialTextRef.current = null;
    initialTextSentRef.current = true;
    deviceNameRef.current = deviceName;
    deviceIdRef.current = deviceId;
    sessionIdRef.current = sessionId;
    sessionSecretRef.current = sessionSecret;
    roleRef.current = "joiner";
    sessionStartedAtRef.current = null;
    historySuppressedRef.current = false;
    dispatch({ type: "SESSION_JOINED", sessionId, sessionSecret });
    dispatch({ type: "PENDING", isPending: true });

    const joinable = await checkJoinable(sessionId);
    if (operationId !== operationIdRef.current) return cancelledOperation();
    if (!joinable.ok) {
      dispatch({ type: "ERROR", error: joinable.error });
      dispatch({ type: "DISCONNECTED", reason: "network" });
      return joinable;
    }

    try {
      const key = await deriveKey(sessionSecret);
      if (operationId !== operationIdRef.current) return cancelledOperation();
      cryptoKeyRef.current = key;
      setupWebRTC(operationId);
      openWebSocket(sessionId, operationId);
      return { ok: true };
    } catch {
      const error = makeError("join_invalid", "This link is not valid.");
      dispatch({ type: "ERROR", error });
      dispatch({ type: "DISCONNECTED", reason: "network" });
      return { ok: false, error };
    }
  }

  async function sendText(
    text: string,
    deviceName: string,
    deviceId: string,
  ): Promise<SessionActionResult> {
    return transmitText(text, deviceName, deviceId);
  }

  async function resumeStoredSession(deviceName: string, deviceId: string): Promise<SessionActionResult> {
    if (window.location.pathname.startsWith("/j/") || resumedRef.current || sessionIdRef.current || rtcRef.current || wsRef.current) {
      return { ok: true };
    }

    const stored = readStoredSession();
    if (!stored) {
      return { ok: true };
    }

    resumedRef.current = true;
    operationIdRef.current += 1;
    const operationId = operationIdRef.current;
    retryCountRef.current = 0;
    intentionalCloseRef.current = false;
    restoreRefs(stored, deviceName, deviceId);
    dispatch({ type: "SESSION_RESTORED", stored });

    try {
      const key = await deriveKey(stored.sessionSecret);
      if (operationId !== operationIdRef.current) return cancelledOperation();
      cryptoKeyRef.current = key;
      setupWebRTC(operationId);
      openWebSocket(stored.sessionId, operationId);
      return { ok: true };
    } catch {
      const error = makeError("join_invalid", "This saved session is not valid.");
      dispatch({ type: "ERROR", error });
      clearStoredSession();
      return { ok: false, error };
    }
  }

  function saveToHistory() {
    if (historySuppressedRef.current || sessionStartedAtRef.current === null) return;
    const s = storeRef.current;
    // Only remember sessions that actually opened a DataChannel.
    if (
      s.sessionId &&
      s.sessionSecret &&
      s.role &&
      s.state !== "WAITING" // don't save sessions that never got a peer
    ) {
      recordSession(
        s.sessionId,
        s.sessionSecret,
        s.role,
        s.peerDeviceName,
        s.items,
        sessionStartedAtRef.current ?? Date.now(),
      );
    }
  }

  function disconnect() {
    saveToHistory();
    historySuppressedRef.current = true;
    operationIdRef.current += 1;
    intentionalCloseRef.current = true;
    closeTransports(true);
    clearStoredSession();
    dispatch({ type: "DISCONNECTED", reason: "manual" });
  }

  function reset() {
    // Forget means forget: beforeunload/cleanup can run before React commits RESET.
    historySuppressedRef.current = true;
    storeRef.current = emptyStore;
    sessionStartedAtRef.current = null;
    operationIdRef.current += 1;
    intentionalCloseRef.current = true;
    closeTransports(true);
    intentionalCloseRef.current = false;
    retryCountRef.current = 0;
    initialTextRef.current = null;
    initialTextSentRef.current = false;
    sessionIdRef.current = null;
    sessionSecretRef.current = null;
    roleRef.current = null;
    clearStoredSession();
    dispatch({ type: "RESET" });
  }

  function clearError() {
    dispatch({ type: "CLEAR_ERROR" });
  }

  function setFileFrameHandler(handler: ((frame: unknown) => void) | null) {
    onFileFrameRef.current = handler;
  }

  function getFileTransport(): FileTransport | null {
    const manager = rtcRef.current;
    const key = cryptoKeyRef.current;
    const operationId = operationIdRef.current;
    if (!manager || !key || dataChannelStateRef.current !== "open") return null;
    if (fileTransportRef.current?.manager === manager) return fileTransportRef.current.transport;
    const active = (signal: AbortSignal) => !signal.aborted && rtcRef.current === manager && operationId === operationIdRef.current;
    const prepare = async (frame: FileFrame, signal: AbortSignal) => {
      if (!active(signal)) throw new Error("Transfer stopped.");
      const bytes = await encryptBytes(key, encodeFileFrame(frame));
      return { send: async () => active(signal) && await manager.sendBuffered(bytes, signal) };
    };
    const transport: FileTransport = {
      chunkSize: Math.min(CHUNK_SIZE, manager.maxMessageSize - FRAME_OVERHEAD),
      prepare,
      send: async (frame, signal) => {
        try { return await (await prepare(frame, signal)).send(); }
        catch { return false; }
      },
    };
    fileTransportRef.current = { manager, transport };
    return transport;
  }

  useEffect(() => {
    writeStoredSession(store);
  }, [store]);

  useEffect(() => {
    intentionalCloseRef.current = false;

    function handleUnload() {
      saveToHistory();
    }
    window.addEventListener("beforeunload", handleUnload);

    return () => {
      window.removeEventListener("beforeunload", handleUnload);
      saveToHistory();
      operationIdRef.current += 1;
      intentionalCloseRef.current = true;
      closeTransports(true);
      resumedRef.current = false;
      sessionIdRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    state: store.state,
    sessionId: store.sessionId,
    sessionSecret: store.sessionSecret,
    role: store.role,
    peerDeviceName: store.peerDeviceName,
    items: store.items,
    initialText: store.initialText,
    error: store.error,
    isPending: store.isPending,
    retryAttempt: store.retryAttempt,
    maxRetries: store.maxRetries,
    dataChannelState: store.dataChannelState,
    terminalReason: store.terminalReason,
    resumeStoredSession,
    createSession,
    joinSession,
    sendText,
    disconnect,
    reset,
    clearError,
    setFileFrameHandler,
    getFileTransport,
  };
}
