import { useRef, useCallback, useState } from "react";
import { WebRTCManager } from "../lib/webrtc";
import type { WebRTCCallbacks } from "../types/index";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/**
 * Thin wrapper around WebRTCManager. Provides send, close, and
 * the current DataChannel state for use by the UI layer.
 */
export function useWebRTC(callbacks: WebRTCCallbacks) {
  const managerRef = useRef<WebRTCManager | null>(null);
  const [dataChannelState, setDataChannelState] =
    useState<RTCDataChannelState | null>(null);

  const stateCallbacks: WebRTCCallbacks = {
    ...callbacks,
    onStateChange: (state) => {
      setDataChannelState(state);
      callbacks.onStateChange(state);
    },
  };

  const getOrCreate = useCallback((): WebRTCManager => {
    if (!managerRef.current) {
      managerRef.current = new WebRTCManager(ICE_SERVERS, stateCallbacks);
    }
    return managerRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback((data: Uint8Array) => {
    return managerRef.current?.send(data) ?? false;
  }, []);

  const close = useCallback(() => {
    managerRef.current?.close();
    managerRef.current = null;
    setDataChannelState(null);
  }, []);

  return { getOrCreate, send, close, dataChannelState };
}
