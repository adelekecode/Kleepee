import { useEffect, useReducer, useRef } from "react";
import { WebRTCManager } from "../lib/webrtc";
import { deriveKey, encrypt, decrypt, generateSessionSecret } from "../lib/crypto";
import type { ClientMessage, ServerMessage, SessionState, TextItem } from "../types";

const WORKER_BASE =
  typeof import.meta.env !== "undefined" && import.meta.env.VITE_WORKER_URL
    ? (import.meta.env.VITE_WORKER_URL as string)
    : "https://kleepee-worker.adelekecode.dev";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const MAX_RETRIES = 3;
const BACKOFF_DELAYS = [2000, 4000, 8000];
const MAX_BYTES = 65536;
const SESSION_STORAGE_KEY = "kleepee.session.current";
const HEARTBEAT_INTERVAL_MS = 25 * 1000;

export type SessionErrorCode =
  | "blank"
  | "too_large"
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
  maxRetries: number;
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

  if (!store.sessionId || !store.sessionSecret || !store.role || store.state === "EXPIRED") {
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
}

function clearStoredSession(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

function getInitialStore(): SessionStore {
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
  maxRetries: number;
  dataChannelState: RTCDataChannelState | null;
  terminalReason: TerminalDisconnectReason;
  resumeStoredSession: (deviceName: string, deviceId: string) => Promise<SessionActionResult>;
  createSession: (initialText: string, deviceName: string, deviceId: string) => Promise<SessionActionResult>;
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
}

function makeError(code: SessionErrorCode, message: string, status?: number): SessionError {
  return { code, message, status };
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

  function restoreRefs(stored: StoredSession, deviceName: string, deviceId: string) {
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

    if (retryCountRef.current >= MAX_RETRIES) {
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

  function setupWebRTC(operationId = operationIdRef.current): WebRTCManager {
    rtcRef.current?.close();

    const manager = new WebRTCManager(ICE_SERVERS, {
      onMessage: async (data: Uint8Array) => {
        if (operationId !== operationIdRef.current || !cryptoKeyRef.current) return;

        try {
          const plain = await decrypt(cryptoKeyRef.current, data);
          const parsed = JSON.parse(plain) as unknown;

          if (
            parsed &&
            typeof parsed === "object" &&
            (parsed as { type?: unknown }).type === "ping"
          ) {
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
      },
      onStateChange: (channelState: RTCDataChannelState) => {
        if (operationId !== operationIdRef.current) return;

        dataChannelStateRef.current = channelState;
        dispatch({ type: "CHANNEL_STATE", dataChannelState: channelState });

        if (channelState === "open") {
          retryCountRef.current = 0;
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
          scheduleReconnect("network");
        }
      },
      onIceCandidate: (candidate: RTCIceCandidate) => {
        if (operationId !== operationIdRef.current) return;
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

    ws.onmessage = async (event: MessageEvent) => {
      if (operationId !== operationIdRef.current || wsRef.current !== ws) return;

      let message: ServerMessage;
      try {
        message = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }

      const rtc = rtcRef.current ?? setupWebRTC(operationId);

      try {
        switch (message.type) {
          case "peer.join": {
            dispatch({ type: "PEER_JOINED", peerDeviceName: message.deviceName });
            dispatch({ type: "CONNECTING" });

            if (roleRef.current === "initiator") {
              const offer = await rtc.createOffer();
              sendSignal({ type: "signal.offer", offer });
            }
            break;
          }
          case "signal.offer": {
            if (roleRef.current === "joiner") {
              dispatch({ type: "CONNECTING" });
              const answer = await rtc.handleOffer(message.offer);
              sendSignal({ type: "signal.answer", answer });
            }
            break;
          }
          case "signal.answer": {
            await rtc.handleAnswer(message.answer);
            break;
          }
          case "signal.ice": {
            await rtc.addIceCandidate(message.candidate);
            break;
          }
          case "session.expired": {
            operationIdRef.current += 1;
            intentionalCloseRef.current = true;
            dispatch({ type: "EXPIRED" });
            closeTransports(true);
            break;
          }
          case "peer.leave": {
            scheduleReconnect("peer_left");
            break;
          }
        }
      } catch {
        scheduleReconnect("network");
      }
    };

    ws.onerror = () => {
      if (operationId !== operationIdRef.current || wsRef.current !== ws) return;
      scheduleReconnect("network");
    };

    ws.onclose = (event: CloseEvent) => {
      if (operationId !== operationIdRef.current || wsRef.current !== ws || intentionalCloseRef.current) return;

      if (event.code === 4410) {
        operationIdRef.current += 1;
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
      const response = await fetch(`${WORKER_BASE}/sessions/${encodeURIComponent(sessionId)}`);

      if (!response.ok) {
        const error = mapJoinStatus(response.status);
        dispatch({ type: "ERROR", error });
        return { ok: false, error };
      }

      const body = (await response.json().catch(() => null)) as {
        sessionState?: SessionState;
        deviceCount?: number;
      } | null;

      if (body?.sessionState === "EXPIRED") {
        const error = makeError("session_expired", "This session has expired.", 410);
        dispatch({ type: "ERROR", error });
        return { ok: false, error };
      }

      if (typeof body?.deviceCount === "number" && body.deviceCount >= 2) {
        const error = makeError("session_full", "This session already has two devices.", 409);
        dispatch({ type: "ERROR", error });
        return { ok: false, error };
      }

      if (typeof body?.deviceCount === "number" && body.deviceCount === 0) {
        const error = makeError("session_not_found", "Session not found.", 404);
        dispatch({ type: "ERROR", error });
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
  ): Promise<SessionActionResult> {
    const validationError = validateText(initialText);
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
      cryptoKeyRef.current = await deriveKey(sessionSecret);

      sessionIdRef.current = sessionId;
      sessionSecretRef.current = sessionSecret;
      roleRef.current = "initiator";

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
    dispatch({ type: "SESSION_JOINED", sessionId, sessionSecret });
    dispatch({ type: "PENDING", isPending: true });

    const joinable = await checkJoinable(sessionId);
    if (!joinable.ok) {
      dispatch({ type: "DISCONNECTED", reason: "network" });
      return joinable;
    }

    try {
      cryptoKeyRef.current = await deriveKey(sessionSecret);
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
    if (resumedRef.current || rtcRef.current || wsRef.current) {
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
      cryptoKeyRef.current = await deriveKey(stored.sessionSecret);
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

  function disconnect() {
    operationIdRef.current += 1;
    intentionalCloseRef.current = true;
    closeTransports(true);
    clearStoredSession();
    dispatch({ type: "DISCONNECTED", reason: "manual" });
  }

  function reset() {
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

  useEffect(() => {
    writeStoredSession(store);
  }, [store]);

  useEffect(() => {
    return () => {
      operationIdRef.current += 1;
      intentionalCloseRef.current = true;
      closeTransports(true);
    };
  }, []);

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
  };
}
