import type { WebRTCCallbacks } from "../types/index";

// Re-export WebRTCCallbacks so consumers can import it from this module
export type { WebRTCCallbacks };

/**
 * WebRTCManager — manages RTCPeerConnection and DataChannel lifecycle.
 * Abstracts all WebRTC complexity from the UI / hook layer.
 */
export class WebRTCManager {
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private callbacks: WebRTCCallbacks;
  private iceServers: RTCIceServer[];
  private pendingIceCandidates: RTCIceCandidateInit[] = [];

  constructor(iceServers: RTCIceServer[], callbacks: WebRTCCallbacks) {
    this.iceServers = iceServers;
    this.callbacks = callbacks;
  }

  private createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.callbacks.onIceCandidate(event.candidate);
      }
    };

    return pc;
  }

  private wireDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;

    channel.binaryType = "arraybuffer";

    channel.onopen = () => {
      this.callbacks.onStateChange("open");
    };

    channel.onclose = () => {
      this.callbacks.onStateChange("closed");
    };

    channel.onerror = () => {
      this.callbacks.onStateChange("closed");
    };

    channel.onmessage = async (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        this.callbacks.onMessage(new Uint8Array(event.data));
        return;
      }

      if (event.data instanceof Blob) {
        this.callbacks.onMessage(new Uint8Array(await event.data.arrayBuffer()));
      }
    };
  }

  private async flushPendingIceCandidates(): Promise<void> {
    if (!this.pc?.remoteDescription) return;

    const candidates = this.pendingIceCandidates.splice(0);
    await Promise.all(candidates.map((candidate) => this.pc?.addIceCandidate(candidate)));
  }

  /**
   * Initiator path: create PeerConnection + DataChannel, return offer SDP.
   */
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.pc = this.createPeerConnection();

    const channel = this.pc.createDataChannel("kleepee");
    this.wireDataChannel(channel);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.callbacks.onOffer(offer);
    return offer;
  }

  /**
   * Joiner path: set remote offer, create answer, return answer SDP.
   * The DataChannel is received via ondatachannel event.
   */
  async handleOffer(
    offer: RTCSessionDescriptionInit
  ): Promise<RTCSessionDescriptionInit> {
    this.pc = this.createPeerConnection();

    this.pc.ondatachannel = (event) => {
      this.wireDataChannel(event.channel);
    };

    await this.pc.setRemoteDescription(offer);
    await this.flushPendingIceCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.callbacks.onAnswer(answer);
    return answer;
  }

  /**
   * Called by initiator when it receives the joiner's answer.
   */
  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) throw new Error("PeerConnection not initialised");
    await this.pc.setRemoteDescription(answer);
    await this.flushPendingIceCandidates();
  }

  /**
   * Add a remote ICE candidate received from the signaling server.
   */
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc || !this.pc.remoteDescription) {
      this.pendingIceCandidates.push(candidate);
      return;
    }

    await this.pc.addIceCandidate(candidate);
  }

  /**
   * Send binary data over the DataChannel. No-op when channel is not open.
   */
  send(data: Uint8Array): boolean {
    if (this.dataChannel?.readyState === "open") {
      this.dataChannel.send(data);
      return true;
    }

    return false;
  }

  /**
   * Returns the current DataChannel state, or null if not yet created.
   */
  get dataChannelState(): RTCDataChannelState | null {
    return this.dataChannel?.readyState ?? null;
  }

  /**
   * Tear down both the DataChannel and PeerConnection.
   */
  close(): void {
    try {
      this.dataChannel?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.dataChannel = null;
    this.pc = null;
    this.pendingIceCandidates = [];
  }
}
