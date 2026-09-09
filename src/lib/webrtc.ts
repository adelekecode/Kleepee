export const FILE_BUFFER_HIGH = 1024 * 1024;
export const FILE_BUFFER_LOW = 512 * 1024;

import { backgroundTimeout } from "./backgroundTimeout";

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
  private iceServers: RTCIceServer[] | (() => Promise<RTCIceServer[]>);
  private generation = 0;
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private connectionTimer: (() => void) | null = null;
  private peerBackground = false;
  private failureReported = false;
  private sendWaiters = new Set<() => void>();

  constructor(
    iceServers: RTCIceServer[] | (() => Promise<RTCIceServer[]>),
    callbacks: WebRTCCallbacks,
  ) {
    this.iceServers = iceServers;
    this.callbacks = callbacks;
  }

  private async createPeerConnection(): Promise<RTCPeerConnection> {
    if (this.pc) this.close();
    const generation = ++this.generation;
    const iceServers =
      typeof this.iceServers === "function"
        ? await this.iceServers()
        : this.iceServers;
    if (generation !== this.generation)
      throw new Error("Connection attempt cancelled.");
    this.failureReported = false;
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    this.startConnectionTimer();

    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;
      if (pc.connectionState === "failed") this.reportFailure();
      if (pc.connectionState === "disconnected") this.startConnectionTimer();
      if (
        pc.connectionState === "connected" &&
        this.dataChannel?.readyState === "open"
      ) {
        this.clearConnectionTimer();
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc === this.pc && pc.iceConnectionState === "failed")
        this.reportFailure();
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.callbacks.onIceCandidate(event.candidate);
      }
    };

    return pc;
  }

  private clearConnectionTimer(): void {
    this.connectionTimer?.();
    this.connectionTimer = null;
  }

  private startConnectionTimer(): void {
    if (this.connectionTimer !== null) return;
    this.connectionTimer = backgroundTimeout(
      () => this.reportFailure(),
      15_000,
      () => this.peerBackground,
    );
  }

  private reportFailure(): void {
    this.clearConnectionTimer();
    if (this.failureReported) return;
    this.failureReported = true;
    this.callbacks.onStateChange("closed");
  }

  private wireDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;

    channel.binaryType = "arraybuffer";

    channel.onopen = () => {
      this.clearConnectionTimer();
      this.callbacks.onStateChange("open");
    };

    channel.onclose = () => {
      this.reportFailure();
    };

    channel.onerror = () => {
      this.reportFailure();
    };

    channel.onmessage = async (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        this.callbacks.onMessage(new Uint8Array(event.data));
        return;
      }

      if (event.data instanceof Blob) {
        this.callbacks.onMessage(
          new Uint8Array(await event.data.arrayBuffer()),
        );
      }
    };
  }

  private async flushPendingIceCandidates(): Promise<void> {
    if (!this.pc?.remoteDescription) return;

    const candidates = this.pendingIceCandidates.splice(0);
    await Promise.all(
      candidates.map((candidate) => this.pc?.addIceCandidate(candidate)),
    );
  }

  /**
   * Initiator path: create PeerConnection + DataChannel, return offer SDP.
   */
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const pc = await this.createPeerConnection();
    if (pc !== this.pc) throw new Error("Connection attempt cancelled.");

    const channel = pc.createDataChannel("kleepee");
    this.wireDataChannel(channel);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.callbacks.onOffer(offer);
    return offer;
  }

  /**
   * Joiner path: set remote offer, create answer, return answer SDP.
   * The DataChannel is received via ondatachannel event.
   */
  async handleOffer(
    offer: RTCSessionDescriptionInit,
  ): Promise<RTCSessionDescriptionInit> {
    const pc = await this.createPeerConnection();
    if (pc !== this.pc) throw new Error("Connection attempt cancelled.");

    pc.ondatachannel = (event) => {
      this.wireDataChannel(event.channel);
    };

    await pc.setRemoteDescription(offer);
    await this.flushPendingIceCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
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
      try {
        if (data.byteLength > this.maxMessageSize) return false;
        this.dataChannel.send(data);
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  get maxMessageSize(): number {
    return this.pc?.sctp?.maxMessageSize ?? 65536;
  }

  /** Files wait for bounded buffer space, leaving room for interactive text. */
  async sendBuffered(data: Uint8Array, signal: AbortSignal): Promise<boolean> {
    const channel = this.dataChannel;
    if (
      !channel ||
      channel.readyState !== "open" ||
      signal.aborted ||
      data.byteLength > this.maxMessageSize
    )
      return false;
    while (
      channel.bufferedAmount + data.byteLength >
      Math.max(FILE_BUFFER_HIGH, data.byteLength)
    ) {
      const ready = await new Promise<boolean>((resolve) => {
        const finish = (ok: boolean) => {
          cancelDeadline();
          this.sendWaiters.delete(closed);
          channel.removeEventListener("bufferedamountlow", drained);
          channel.removeEventListener("close", closed);
          channel.removeEventListener("error", closed);
          signal.removeEventListener("abort", closed);
          resolve(ok);
        };
        const drained = () => finish(true);
        const closed = () => finish(false);
        const cancelDeadline = backgroundTimeout(
          closed,
          60_000,
          () => this.peerBackground,
        );
        this.sendWaiters.add(closed);
        channel.bufferedAmountLowThreshold = FILE_BUFFER_LOW;
        channel.addEventListener("bufferedamountlow", drained, { once: true });
        channel.addEventListener("close", closed, { once: true });
        channel.addEventListener("error", closed, { once: true });
        signal.addEventListener("abort", closed, { once: true });
        if (signal.aborted || channel.readyState !== "open") closed();
        else if (channel.bufferedAmount <= FILE_BUFFER_LOW) drained();
      });
      if (
        !ready ||
        signal.aborted ||
        this.dataChannel !== channel ||
        channel.readyState !== "open"
      )
        return false;
    }
    if (signal.aborted || this.dataChannel !== channel) return false;
    return this.send(data);
  }

  setPeerBackground(hidden: boolean): void {
    this.peerBackground = hidden;
  }

  /** Recheck after foregrounding; do not replace a healthy DataChannel. */
  recover(): void {
    if (!this.pc) return;
    if (
      this.pc.connectionState === "failed" ||
      this.dataChannel?.readyState === "closed"
    ) {
      this.reportFailure();
    } else if (this.pc.connectionState === "disconnected") {
      this.clearConnectionTimer();
      this.startConnectionTimer();
    }
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
    this.generation += 1;
    for (const stop of this.sendWaiters) stop();
    this.clearConnectionTimer();
    // Closing an old transport must not start another reconnect attempt.
    if (this.dataChannel) {
      this.dataChannel.onopen = null;
      this.dataChannel.onclose = null;
      this.dataChannel.onerror = null;
      this.dataChannel.onmessage = null;
    }
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.ondatachannel = null;
    }
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
