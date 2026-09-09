// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileTransferManager,
  PREPARE_WINDOW,
  PROGRESS_INTERVAL_MS,
} from "./fileTransferManager";
import { CHUNK_SIZE, decodeFileFrame, encodeFileFrame } from "./fileTransfer";
import {
  decryptBytes,
  deriveKey,
  encryptBytes,
  generateSessionSecret,
} from "./crypto";
import type {
  FileFrame,
  FileStartFrame,
  PreparedFileFrame,
} from "../types/files";

const device = { deviceId: "speed-device", deviceName: "Calm Otter" };
const managers: FileTransferManager[] = [];
function manager() {
  const value = new FileTransferManager();
  managers.push(value);
  return value;
}
function items(value: FileTransferManager) {
  return [
    ...value.getSnapshot().transfers.values(),
    ...value.getSnapshot().fileItems,
  ];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
function controlledSender() {
  const value = manager();
  const preparations = new Map<
    number,
    ReturnType<typeof deferred<PreparedFileFrame>>
  >();
  const sent: number[] = [];
  value.setTransport({
    chunkSize: 1024,
    send: async (frame) => {
      if (frame.type === "file.complete")
        value.handleFrame({ type: "file.ack", id: frame.id });
      return true;
    },
    prepare: async (frame) => {
      if (frame.type !== "file.chunk") throw new Error("Expected chunk");
      const gate = deferred<PreparedFileFrame>();
      preparations.set(frame.index, gate);
      return gate.promise;
    },
  });
  // Deterministic reads let the test inspect scheduling without native File I/O timing.
  const file = new File([new Uint8Array(8 * 1024)], "pipeline.bin");
  const reads = vi.spyOn(file, "slice").mockImplementation(
    () =>
      ({
        arrayBuffer: async () => new ArrayBuffer(1024),
      }) as Blob,
  );
  value.enqueue([file], device);
  const release = (index: number) =>
    preparations.get(index)!.resolve({
      send: async () => {
        sent.push(index);
        return true;
      },
    });
  return { value, preparations, sent, reads, release };
}
function incomingStart(): FileStartFrame {
  return {
    type: "file.start",
    id: "speed-incoming",
    senderId: "peer",
    senderName: "Bright Fox",
    timestamp: 1,
    fileName: "progress.bin",
    mimeType: "application/octet-stream",
    fileSize: 4 * 1024,
    chunkSize: 1024,
    totalChunks: 4,
  };
}

afterEach(() => {
  managers.splice(0).forEach((value) => value.clear());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bounded file preparation", () => {
  it("reads ahead by four chunks and sends in order despite out-of-order preparation", async () => {
    const { preparations, sent, reads, release, value } = controlledSender();
    await flush();
    expect(PREPARE_WINDOW).toBe(4);
    expect([...preparations.keys()]).toEqual([0, 1, 2, 3]);
    expect(reads).toHaveBeenCalledTimes(4);
    release(3);
    release(2);
    release(1);
    await flush();
    expect(sent).toEqual([]);
    expect(reads).toHaveBeenCalledTimes(4);
    release(0);
    await flush();
    expect(sent).toEqual([0, 1, 2, 3]);
    expect([...preparations.keys()]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    release(7);
    release(6);
    release(5);
    release(4);
    await flush();
    expect(sent).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(items(value)[0].status).toBe("complete");
  });

  it.each(["cancel", "disconnect", "reset"])(
    "does not send prepared chunks after %s, including late failures",
    async (operation) => {
      const { preparations, sent, release, value } = controlledSender();
      await flush();
      const id = items(value)[0].id;
      release(1);
      if (operation === "cancel") value.cancel(id);
      else if (operation === "disconnect") value.connectionLost();
      else value.clear();
      // Rejection is attached immediately even though this future chunk is never awaited.
      preparations.get(3)!.reject(new Error("Encryption aborted"));
      release(2);
      release(0);
      await flush();
      expect(sent).toEqual([]);
      expect(preparations.size).toBe(4);
      if (operation === "reset") expect(items(value)).toEqual([]);
      else
        expect(items(value)[0].status).toBe(
          operation === "cancel" ? "cancelled" : "paused",
        );
    },
  );

  it("delivers an exact 4 MiB download through prepared encryption and receiver acknowledgement", async () => {
    const sender = manager();
    const receiver = manager();
    const key = await deriveKey(generateSessionSecret());
    const prepared = vi.fn(
      async (
        frame: FileFrame,
        signal: AbortSignal,
      ): Promise<PreparedFileFrame> => {
        const encrypted = await encryptBytes(key, encodeFileFrame(frame));
        return {
          send: async () => {
            if (signal.aborted) return false;
            receiver.handleFrame(
              decodeFileFrame(await decryptBytes(key, encrypted)),
            );
            return true;
          },
        };
      },
    );
    sender.setTransport({
      chunkSize: CHUNK_SIZE,
      prepare: prepared,
      send: async (frame, signal) => {
        return (await prepared(frame, signal)).send();
      },
    });
    receiver.setTransport({
      chunkSize: CHUNK_SIZE,
      send: async (frame) => {
        sender.handleFrame(frame);
        return true;
      },
    });
    const bytes = Uint8Array.from(
      { length: 4 * 1024 * 1024 },
      (_, index) => index % 251,
    );
    sender.enqueue([new File([bytes], "four-mib.bin")], device);
    await vi.waitFor(() => expect(items(sender)[0]?.status).toBe("complete"), {
      timeout: 5000,
    });
    const received = items(receiver)[0];
    expect(received.status).toBe("complete");
    const downloaded = await (await fetch(received.objectUrl!)).arrayBuffer();
    expect(downloaded.byteLength).toBe(bytes.byteLength);
    expect(
      new Uint8Array(await crypto.subtle.digest("SHA-256", downloaded)),
    ).toEqual(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
    expect(
      prepared.mock.calls.filter(([frame]) => frame.type === "file.chunk"),
    ).toHaveLength(64);
  });
});

describe("coalesced file progress", () => {
  it.each(["complete", "failed", "cancelled", "clear"])(
    "publishes progress at 100 ms and %s immediately without leaking a timer",
    async (terminal) => {
      vi.useFakeTimers();
      const value = manager();
      value.setTransport({ chunkSize: 1024, send: async () => true });
      const listener = vi.fn();
      value.subscribe(listener);
      const start = incomingStart();
      value.handleFrame(start);
      expect(listener).toHaveBeenCalledTimes(1);
      for (let index = 0; index < 2; index++)
        value.handleFrame({
          type: "file.chunk",
          id: start.id,
          index,
          data: new Uint8Array(1024),
        });
      expect(listener).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS - 1);
      expect(listener).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(items(value)[0].progress).toBe(0.5);
      value.handleFrame({
        type: "file.chunk",
        id: start.id,
        index: 2,
        data: new Uint8Array(1024),
      });
      if (terminal === "complete") {
        value.handleFrame({
          type: "file.chunk",
          id: start.id,
          index: 3,
          data: new Uint8Array(1024),
        });
        value.handleFrame({ type: "file.complete", id: start.id });
      } else if (terminal === "failed") value.handleFrame({
        type: "file.chunk", id: start.id, index: 999, data: new Uint8Array(1024),
      });
      else if (terminal === "cancelled") value.cancel(start.id);
      else value.clear();
      expect(listener).toHaveBeenCalledTimes(3);
      if (terminal === "clear") expect(items(value)).toEqual([]);
      else expect(items(value)[0].status).toBe(terminal);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(listener).toHaveBeenCalledTimes(3);
    },
  );
});
