import { CHUNK_SIZE, isValidStartFrame, MAX_FILE_BYTES, planChunks, readChunk, validateFile, validFileId } from "./fileTransfer";
import type { DeviceIdentity } from "../types";
import type { FileFrame, FileItem, FileSelectionResult, FileStartFrame, FileTransfer, FileTransport, PreparedFileFrame } from "../types/files";

export const TRANSFER_TIMEOUT_MS = 60_000;
const MAX_RETAINED_BYTES = 100 * 1024 * 1024;
const MAX_PENDING_FILES = 20;
export const PREPARE_WINDOW = 4;
export const PROGRESS_INTERVAL_MS = 100;
interface Outgoing { file: File; controller: AbortController }
interface Incoming { start: FileStartFrame; chunks: Uint8Array[]; bytes: number; timer: ReturnType<typeof setTimeout> }
interface Snapshot { transfers: Map<string, FileTransfer>; fileItems: FileItem[] }

/** One instance per session provider. All file bytes stay outside React and browser storage. */
export class FileTransferManager {
  private items = new Map<string, FileTransfer>();
  private outgoing = new Map<string, Outgoing>();
  private incoming = new Map<string, Incoming>();
  private queue: string[] = [];
  private transport: FileTransport | null = null;
  private pumping = false;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  private retainedReceiveBytes = 0;
  private urls = new Set<string>();
  private acknowledgements = new Map<string, (ok: boolean) => void>();
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = { transfers: new Map(), fileItems: [] };

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private publish() {
    if (this.progressTimer !== null) clearTimeout(this.progressTimer);
    this.progressTimer = null;
    const values = [...this.items.values()];
    this.snapshot = {
      transfers: new Map(values.filter((item) => ["queued", "sending", "receiving"].includes(item.status)).map((item) => [item.id, item])),
      fileItems: values.filter((item) => ["complete", "failed", "cancelled"].includes(item.status)),
    };
    this.listeners.forEach((listener) => listener());
  }
  private update(id: string, patch: Partial<FileTransfer>, progressOnly = false) {
    const item = this.items.get(id);
    if (!item) return;
    this.items.set(id, { ...item, ...patch });
    if (!progressOnly) this.publish();
    else if (this.progressTimer === null) {
      this.progressTimer = setTimeout(() => this.publish(), PROGRESS_INTERVAL_MS);
    }
  }

  enqueue = (files: File[], device: DeviceIdentity): FileSelectionResult => {
    const result: FileSelectionResult = { accepted: [], errors: [] };
    let bytes = [...this.outgoing.values()].reduce((sum, job) => sum + job.file.size, 0);
    for (const file of files) {
      const error = validateFile(file);
      if (error) { result.errors.push(`${file.name}: ${error}`); continue; }
      if (this.outgoing.size >= MAX_PENDING_FILES || bytes + file.size > MAX_RETAINED_BYTES) {
        result.errors.push(`${file.name}: The file queue is full. Send or cancel queued files first.`);
        continue;
      }
      const id = crypto.randomUUID();
      this.outgoing.set(id, { file, controller: new AbortController() });
      this.items.set(id, {
        id, type: "file", ...{ senderId: device.deviceId, senderName: device.deviceName }, timestamp: Date.now(),
        fileName: file.name, fileSize: file.size, mimeType: file.type || "application/octet-stream",
        status: "queued", progress: 0, receivedChunks: 0, totalChunks: planChunks(file),
      });
      this.queue.push(id);
      bytes += file.size;
      result.accepted.push(file);
    }
    this.publish();
    void this.pump();
    return result;
  };

  setTransport(transport: FileTransport | null) {
    if (this.transport === transport) return;
    if (this.transport) this.connectionLost();
    this.transport = transport;
    if (transport) void this.pump();
  }

  connectionLost() {
    this.transport = null;
    for (const [id, item] of this.items) {
      if (item.status === "sending") this.failOutgoing(id, "Connection lost. Reconnect, then retry.");
    }
    for (const id of this.incoming.keys()) this.failIncoming(id, "Connection lost. Ask the sender to retry.", false);
  }

  private failOutgoing(id: string, error: string) {
    this.outgoing.get(id)?.controller.abort();
    this.acknowledgements.get(id)?.(false);
    this.update(id, { status: "failed", error, canRetry: this.outgoing.has(id) });
  }

  private async pump() {
    if (this.pumping || !this.transport) return;
    this.pumping = true;
    const epoch = this.epoch;
    try {
      while (this.transport && this.queue.length && epoch === this.epoch) {
        const id = this.queue.shift()!;
        const job = this.outgoing.get(id);
        if (!job || this.items.get(id)?.status !== "queued") continue;
        await this.sendFile(id, job, this.transport);
      }
    } finally {
      this.pumping = false;
      if (this.transport && this.queue.length) void this.pump();
    }
  }

  private async sendFile(id: string, job: Outgoing, transport: FileTransport) {
    const signal = job.controller.signal;
    const chunkSize = Math.min(CHUNK_SIZE, transport.chunkSize);
    const totalChunks = planChunks(job.file, chunkSize);
    const item = this.items.get(id)!;
    const active = () => !signal.aborted && this.outgoing.get(id) === job && this.transport === transport;
    const send = async (frame: FileFrame) => {
      if (!active()) throw new Error("Transfer stopped.");
      if (!await transport.send(frame, signal)) throw new Error("Could not send file. Reconnect, then retry.");
      if (!active()) throw new Error("Transfer stopped.");
    };
    this.update(id, { status: "sending", totalChunks, error: undefined, canRetry: false });
    try {
      if (!Number.isInteger(chunkSize) || chunkSize < 1024) throw new Error("Connection cannot carry file chunks.");
      await send({ type: "file.start", id, senderId: item.senderId, senderName: item.senderName, timestamp: item.timestamp,
        fileName: item.fileName, fileSize: item.fileSize, mimeType: item.mimeType, totalChunks, chunkSize });
      // Bound file reads and encryption to four chunks, overlapping preparation
      // with network drain. Every promise handles rejection immediately so a
      // cancelled future chunk cannot create an unhandled rejection.
      type Preparation = { frame: PreparedFileFrame } | { error: unknown };
      const prepare = async (index: number): Promise<Preparation> => {
        try {
          if (!active()) throw new Error("Transfer stopped.");
          const data = await readChunk(job.file, index, chunkSize);
          if (!active()) throw new Error("Transfer stopped.");
          const chunk: FileFrame = { type: "file.chunk", id, index, data };
          const frame = transport.prepare
            ? await transport.prepare(chunk, signal)
            : { send: () => transport.send(chunk, signal) };
          return { frame };
        } catch (error) { return { error }; }
      };
      const pending: Promise<Preparation>[] = [];
      let next = 0;
      const fill = () => {
        while (pending.length < PREPARE_WINDOW && next < totalChunks && active()) pending.push(prepare(next++));
      };
      fill();
      for (let index = 0; index < totalChunks; index++) {
        const prepared = await pending.shift()!;
        if (!active()) return;
        if ("error" in prepared) throw prepared.error;
        if (!await prepared.frame.send()) throw new Error("Could not send file. Reconnect, then retry.");
        if (!active()) return;
        this.update(id, { progress: (index + 1) / totalChunks, receivedChunks: index + 1 }, true);
        fill();
      }
      this.update(id, { progress: 1 });
      let timer: ReturnType<typeof setTimeout>;
      const acknowledgement = new Promise<boolean>((resolve) => {
        const finish = (ok: boolean) => { clearTimeout(timer); this.acknowledgements.delete(id); resolve(ok); };
        this.acknowledgements.set(id, finish);
        timer = setTimeout(() => finish(false), TRANSFER_TIMEOUT_MS);
      });
      try {
        await send({ type: "file.complete", id });
        if (!await acknowledgement) throw new Error("Delivery was not confirmed. Retry the file.");
      } finally {
        this.acknowledgements.get(id)?.(false);
      }
      if (!active()) return;
      this.outgoing.delete(id);
      this.update(id, { status: "complete", progress: 1, canRetry: false });
    } catch (error) {
      if (!active()) return;
      this.control({ type: "file.cancel", id });
      this.failOutgoing(id, error instanceof Error ? error.message : "File transfer failed.");
    }
  }

  retry = (id: string): boolean => {
    const old = this.items.get(id);
    const job = this.outgoing.get(id);
    if (!this.transport || !old || old.status !== "failed" || !job) return false;
    // A fresh wire ID prevents delayed chunks or acknowledgements matching a retry.
    this.items.delete(id);
    this.outgoing.delete(id);
    return this.enqueue([job.file], { deviceId: old.senderId, deviceName: old.senderName }).accepted.length === 1;
  };

  cancel = (id: string) => {
    const item = this.items.get(id);
    if (!item || item.status === "complete" || item.status === "cancelled") return;
    this.control({ type: "file.cancel", id });
    this.outgoing.get(id)?.controller.abort();
    this.outgoing.delete(id);
    this.acknowledgements.get(id)?.(false);
    this.releaseIncoming(id);
    this.update(id, { status: "cancelled", canRetry: false, error: undefined });
  };

  private control(frame: FileFrame) {
    // Controls still go through the encrypted, bounded transport. They cannot throw into the UI.
    void this.transport?.send(frame, new AbortController().signal).catch(() => false);
  }
  private releaseIncoming(id: string, keepBytes = false) {
    const entry = this.incoming.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (!keepBytes) this.retainedReceiveBytes -= entry.start.fileSize;
    this.incoming.delete(id);
  }
  private failIncoming(id: string, error: string, notify = true) {
    this.releaseIncoming(id);
    this.update(id, { status: "failed", error, canRetry: false });
    if (notify) this.control({ type: "file.reject", id });
  }
  private receiveDeadline(id: string) {
    return setTimeout(() => this.failIncoming(id, "Transfer timed out. Ask the sender to retry."), TRANSFER_TIMEOUT_MS);
  }

  handleFrame = (value: unknown) => {
    if (!this.transport || !value || typeof value !== "object") return;
    const frame = value as FileFrame;
    const id = frame.id;
    if (!validFileId(frame.id)) return;
    if (frame.type === "file.start") {
      if (this.items.size >= 1000) { this.control({ type: "file.reject", id }); return; }
      if (this.items.has(frame.id)) {
        if (this.incoming.has(frame.id)) this.failIncoming(frame.id, "Duplicate file transfer.");
        else this.control({ type: "file.reject", id: frame.id });
        return;
      }
      if (!isValidStartFrame(frame)) {
        this.control({ type: "file.reject", id });
        return;
      }
      const transfer: FileTransfer = { ...frame, type: "file", status: "receiving", progress: 0, receivedChunks: 0 };
      this.items.set(frame.id, transfer);
      if (this.incoming.size >= 1 || this.retainedReceiveBytes + frame.fileSize > MAX_RETAINED_BYTES) {
        this.update(frame.id, { status: "failed", error: "Receiving limit reached. Start a new session to free memory." });
        this.control({ type: "file.reject", id: frame.id });
        return;
      }
      this.retainedReceiveBytes += frame.fileSize;
      this.incoming.set(frame.id, { start: frame, chunks: [], bytes: 0, timer: this.receiveDeadline(frame.id) });
      this.publish();
      return;
    }
    if (frame.type === "file.ack") {
      this.acknowledgements.get(frame.id)?.(true);
      return;
    }
    if (frame.type === "file.cancel" || frame.type === "file.reject") {
      const item = this.items.get(frame.id);
      if (!item || !["sending", "receiving", "queued"].includes(item.status)) return;
      const rejected = frame.type === "file.reject";
      this.outgoing.get(frame.id)?.controller.abort();
      this.acknowledgements.get(frame.id)?.(false);
      this.releaseIncoming(frame.id);
      if (!rejected) this.outgoing.delete(frame.id);
      this.update(frame.id, { status: rejected ? "failed" : "cancelled", canRetry: rejected && this.outgoing.has(frame.id),
        error: rejected ? "The other device could not receive this file. Retry when ready." : undefined });
      return;
    }
    const entry = this.incoming.get(frame.id);
    if (!entry) return;
    if (frame.type === "file.chunk") {
      const expected = Math.min(entry.start.chunkSize, entry.start.fileSize - entry.bytes);
      if (!Number.isSafeInteger(frame.index) || frame.index !== entry.chunks.length
        || frame.index >= entry.start.totalChunks || !(frame.data instanceof Uint8Array)
        || frame.data.byteLength !== expected || entry.bytes + frame.data.byteLength > MAX_FILE_BYTES) {
        this.failIncoming(frame.id, "Invalid or out-of-order file chunk.");
        return;
      }
      entry.chunks.push(frame.data);
      entry.bytes += frame.data.byteLength;
      clearTimeout(entry.timer);
      entry.timer = this.receiveDeadline(frame.id);
      this.update(frame.id, { receivedChunks: entry.chunks.length, progress: entry.bytes / entry.start.fileSize }, true);
      return;
    }
    if (frame.type === "file.complete") {
      if (entry.chunks.length !== entry.start.totalChunks || entry.bytes !== entry.start.fileSize) {
        this.failIncoming(frame.id, "File is incomplete. Ask the sender to retry.");
        return;
      }
      try {
        const url = URL.createObjectURL(new Blob(entry.chunks, { type: entry.start.mimeType }));
        this.urls.add(url);
        this.releaseIncoming(frame.id, true);
        this.update(frame.id, { status: "complete", progress: 1, objectUrl: url });
        this.control({ type: "file.ack", id: frame.id });
      } catch {
        this.failIncoming(frame.id, "Could not prepare the download.");
      }
      return;
    }
    this.failIncoming(frame.id, "Invalid file frame.");
  };

  clear = () => {
    this.epoch++;
    for (const job of this.outgoing.values()) job.controller.abort();
    for (const finish of this.acknowledgements.values()) finish(false);
    for (const entry of this.incoming.values()) clearTimeout(entry.timer);
    this.urls.forEach((url) => URL.revokeObjectURL(url));
    this.urls.clear();
    this.transport = null;
    this.retainedReceiveBytes = 0;
    this.queue = [];
    this.incoming.clear();
    this.outgoing.clear();
    this.items.clear();
    this.publish();
  };
}
