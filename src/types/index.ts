export type SessionState =
  | "WAITING"
  | "CONNECTING"
  | "CONNECTED"
  | "DISCONNECTED"
  | "EXPIRED";

export interface TextItem {
  id: string;
  type: "text";
  senderId: string;
  senderName: string;
  timestamp: number;
  content: string;
}

export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
}

export interface SessionContext {
  sessionId: string;
  sessionSecret: string;
  state: SessionState;
  role: "initiator" | "joiner";
  peerDeviceName: string | null;
  items: TextItem[];
}

export interface WebRTCCallbacks {
  onMessage: (data: Uint8Array) => void;
  onStateChange: (state: RTCDataChannelState) => void;
  onIceCandidate: (candidate: RTCIceCandidate) => void;
  onOffer: (offer: RTCSessionDescriptionInit) => void;
  onAnswer: (answer: RTCSessionDescriptionInit) => void;
}

export type ClientMessage =
  | { type: "signal.offer"; offer: RTCSessionDescriptionInit }
  | { type: "signal.answer"; answer: RTCSessionDescriptionInit }
  | { type: "signal.ice"; candidate: RTCIceCandidateInit };

export type ServerMessage =
  | { type: "peer.join"; deviceName: string }
  | { type: "peer.leave" }
  | { type: "signal.offer"; offer: RTCSessionDescriptionInit }
  | { type: "signal.answer"; answer: RTCSessionDescriptionInit }
  | { type: "signal.ice"; candidate: RTCIceCandidateInit }
  | { type: "session.expired" };
