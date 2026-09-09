// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileTransferManager,
  TRANSFER_TIMEOUT_MS,
} from "./fileTransferManager";
import { CHUNK_SIZE, MAX_FILE_BYTES } from "./fileTransfer";
import type {
  FileFrame,
  FileItem,
  FileStartFrame,
  FileTransport,
} from "../types/files";

const device = { deviceId: "device-a", deviceName: "Calm Otter" };
const managers: FileTransferManager[] = [];
function manager() {
  const value = new FileTransferManager();
  managers.push(value);
  return value;
}
function items(value: FileTransferManager): FileItem[] {
  const snapshot = value.getSnapshot();
  return [...snapshot.transfers.values(), ...snapshot.fileItems];
}
function item(value: FileTransferManager, id: string) {
  return items(value).find((entry) => entry.id === id);
}
function start(patch: Partial<FileStartFrame> = {}): FileStartFrame {
  return {
    type: "file.start",
    id: "incoming-1",
    senderId: "device-b",
    senderName: "Bright Fox",
    timestamp: 1,
    fileName: "file.bin",
    mimeType: "application/octet-stream",
    fileSize: 1026,
    chunkSize: 1024,
    totalChunks: 2,
    ...patch,
  };
}
function recordingTransport(frames: FileFrame[] = []): FileTransport {
  return {
    chunkSize: CHUNK_SIZE,
    send: async (frame) => {
      frames.push(frame);
      return true;
    },
  };
}
function receiver() {
  const value = manager();
  const frames: FileFrame[] = [];
  value.setTransport(recordingTransport(frames));
  return { value, frames };
}
function connect(a: FileTransferManager, b: FileTransferManager) {
  const frames: FileFrame[] = [];
  a.setTransport({
    chunkSize: CHUNK_SIZE,
    send: async (frame, signal) => {
      if (signal.aborted) return false;
      frames.push(frame);
      b.handleFrame(frame);
      return true;
    },
  });
  b.setTransport({
    chunkSize: CHUNK_SIZE,
    send: async (frame, signal) => {
      if (signal.aborted) return false;
      a.handleFrame(frame);
      return true;
    },
  });
  return frames;
}
async function flush() {
  for (let count = 0; count < 30; count++) await Promise.resolve();
}

afterEach(() => {
  managers.splice(0).forEach((value) => value.clear());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("file transfer delivery", () => {
  it.each([0, CHUNK_SIZE + 7, MAX_FILE_BYTES])(
    "delivers and acknowledges exactly %i bytes",
    async (size) => {
      const a = manager();
      const b = manager();
      const frames = connect(a, b);
      const bytes = Uint8Array.from(
        { length: size },
        (_, index) => index % 251,
      );
      expect(
        a.enqueue([new File([bytes], "archive.custom")], device).errors,
      ).toEqual([]);
      await vi.waitFor(() => expect(items(a)[0]?.status).toBe("complete"), {
        timeout: 5000,
      });
      const received = items(b)[0];
      expect(received.status).toBe("complete");
      expect(received.fileSize).toBe(size);
      const downloaded = await (await fetch(received.objectUrl!)).arrayBuffer();
      expect(downloaded.byteLength).toBe(size);
      expect(
        new Uint8Array(await crypto.subtle.digest("SHA-256", downloaded)),
      ).toEqual(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
      expect(
        frames.filter((frame) => frame.type === "file.chunk"),
      ).toHaveLength(Math.ceil(size / CHUNK_SIZE));
    },
  );

  it("waits for receiver acknowledgement and sends only one queued file at a time", async () => {
    const value = manager();
    const frames: FileFrame[] = [];
    value.setTransport(recordingTransport(frames));
    value.enqueue([new File([], "first"), new File([], "second")], device);
    await flush();
    const firstId = frames[0].id;
    expect(frames.filter((frame) => frame.type === "file.start")).toHaveLength(
      1,
    );
    expect(item(value, firstId)?.status).toBe("sending");
    expect(
      items(value).filter((entry) => entry.status === "queued"),
    ).toHaveLength(1);
    value.handleFrame({ type: "file.ack", id: "wrong-id" });
    await flush();
    expect(item(value, firstId)?.status).toBe("sending");
    value.handleFrame({ type: "file.ack", id: firstId });
    await flush();
    expect(item(value, firstId)?.status).toBe("complete");
    expect(frames.filter((frame) => frame.type === "file.start")).toHaveLength(
      2,
    );
  });

  it("keeps files queued until a connection is available", async () => {
    const value = manager();
    const frames: FileFrame[] = [];
    value.enqueue([new File([], "queued")], device);
    await flush();
    expect(items(value)[0].status).toBe("queued");
    value.setTransport(recordingTransport(frames));
    await flush();
    expect(frames.map((frame) => frame.type)).toEqual([
      "file.start",
      "file.complete",
    ]);
  });

  it("marks a failed completion send as failed with a retained retry", async () => {
    const value = manager();
    value.setTransport({
      chunkSize: CHUNK_SIZE,
      send: async (frame) => frame.type !== "file.complete",
    });
    value.enqueue([new File([], "empty")], device);
    await flush();
    expect(items(value)[0]).toMatchObject({ status: "failed", canRetry: true });
  });

  it("returns rejected attachments without hiding accepted files", () => {
    const value = manager();
    const empty = new File([], "empty");
    const result = value.enqueue(
      [empty, new File([new Uint8Array(MAX_FILE_BYTES + 1)], "too-big")],
      device,
    );
    expect(result.accepted).toEqual([empty]);
    expect(result.errors).toEqual([expect.stringContaining("too-big")]);
    expect(items(value)).toHaveLength(1);
  });
});

describe("incoming validation and cancellation", () => {
  it.each([
    ["missing", [{ type: "file.complete", id: "incoming-1" }]],
    [
      "wrong byte count",
      [
        {
          type: "file.chunk",
          id: "incoming-1",
          index: 0,
          data: new Uint8Array(1),
        },
      ],
    ],
    [
      "oversized",
      [
        {
          type: "file.chunk",
          id: "incoming-1",
          index: 0,
          data: new Uint8Array(1025),
        },
      ],
    ],
    [
      "out of order",
      [
        {
          type: "file.chunk",
          id: "incoming-1",
          index: 1,
          data: new Uint8Array(1024),
        },
      ],
    ],
    [
      "duplicate",
      [
        {
          type: "file.chunk",
          id: "incoming-1",
          index: 0,
          data: new Uint8Array(1024),
        },
        {
          type: "file.chunk",
          id: "incoming-1",
          index: 0,
          data: new Uint8Array(1024),
        },
      ],
    ],
    [
      "incorrect final size",
      [
        {
          type: "file.chunk",
          id: "incoming-1",
          index: 0,
          data: new Uint8Array(1024),
        },
        {
          type: "file.chunk",
          id: "incoming-1",
          index: 1,
          data: new Uint8Array(1),
        },
        { type: "file.complete", id: "incoming-1" },
      ],
    ],
    [
      "non-binary",
      [{ type: "file.chunk", id: "incoming-1", index: 0, data: "AAAA" }],
    ],
    ["unknown frame", [{ type: "file.surprise", id: "incoming-1" }]],
  ])("rejects %s chunks without a downloadable partial file", (_, frames) => {
    const { value, frames: sent } = receiver();
    value.handleFrame(start());
    frames.forEach((frame) => value.handleFrame(frame));
    expect(item(value, "incoming-1")).toMatchObject({
      status: "failed",
      canRetry: false,
    });
    expect(item(value, "incoming-1")?.objectUrl).toBeUndefined();
    expect(sent).toContainEqual({ type: "file.reject", id: "incoming-1" });
    value.handleFrame(start({ id: "next-file" }));
    expect(item(value, "next-file")?.status).toBe("receiving");
  });

  it("rejects malicious metadata and duplicate starts without allocating a download", () => {
    const { value, frames } = receiver();
    value.handleFrame(start({ fileSize: MAX_FILE_BYTES + 1 }));
    expect(items(value)).toEqual([]);
    expect(frames).toContainEqual({ type: "file.reject", id: "incoming-1" });
    value.handleFrame(start());
    value.handleFrame(start());
    expect(item(value, "incoming-1")?.status).toBe("failed");
  });

  it.each(["sender", "receiver"])(
    "propagates %s cancellation and ignores late chunks",
    async (side) => {
      const a = manager();
      const b = manager();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      a.setTransport({
        chunkSize: CHUNK_SIZE,
        send: async (frame) => {
          if (frame.type === "file.start") {
            b.handleFrame(frame);
            await blocked;
          } else b.handleFrame(frame);
          return true;
        },
      });
      b.setTransport({
        chunkSize: CHUNK_SIZE,
        send: async (frame) => {
          a.handleFrame(frame);
          return true;
        },
      });
      a.enqueue([new File(["hello"], "hello.txt")], device);
      const id = items(a)[0].id;
      (side === "sender" ? a : b).cancel(id);
      release();
      await flush();
      expect(item(a, id)?.status).toBe("cancelled");
      expect(item(b, id)?.status).toBe("cancelled");
      b.handleFrame({
        type: "file.chunk",
        id,
        index: 0,
        data: new TextEncoder().encode("hello"),
      });
      b.handleFrame({ type: "file.complete", id });
      expect(item(b, id)?.objectUrl).toBeUndefined();
    },
  );
});

describe("connection lifecycle and cleanup", () => {
  it("resumes an interrupted acknowledgement under the same ID after reconnect", async () => {
    const a = manager();
    const b = manager();
    const frames: FileFrame[] = [];
    a.setTransport({
      chunkSize: CHUNK_SIZE,
      send: async (frame) => {
        frames.push(frame);
        b.handleFrame(frame);
        return true;
      },
    });
    b.setTransport(recordingTransport()); // Deliberately withhold acknowledgement.
    a.enqueue([new File([], "retry-me")], device);
    await flush();
    const oldId = items(a)[0].id;
    a.setTransport(null);
    expect(item(a, oldId)).toMatchObject({ status: "paused", canRetry: false });
    expect(a.retry(oldId)).toBe(false);
    connect(a, b);
    expect(a.retry(oldId)).toBe(false);
    await vi.waitFor(() => expect(items(a)[0]?.status).toBe("complete"));
    expect(items(a)[0].id).toBe(oldId);
    expect(items(b)).toHaveLength(1);
  });

  it("retains an incomplete receive on connection loss", () => {
    const { value } = receiver();
    value.handleFrame(start());
    value.setTransport(null);
    expect(item(value, "incoming-1")).toMatchObject({
      status: "paused",
    });
    expect(item(value, "incoming-1")?.objectUrl).toBeUndefined();
    value.setTransport(recordingTransport());
    value.handleFrame({ ...start(), type: "file.resume", requestId: "resume-1" });
    expect(item(value, "incoming-1")?.status).toBe("receiving");
  });

  it("times out missing chunks and unacknowledged sends", async () => {
    vi.useFakeTimers();
    const { value } = receiver();
    value.handleFrame(start());
    value.enqueue([new File([], "no-ack")], device);
    await flush();
    await vi.advanceTimersByTimeAsync(2 * TRANSFER_TIMEOUT_MS + 1);
    expect(items(value)).toHaveLength(2);
    expect(items(value).every((entry) => entry.status === "failed")).toBe(true);
  });

  it("revokes completed object URLs when cleared", () => {
    const { value } = receiver();
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    value.handleFrame(start({ fileSize: 0, totalChunks: 0 }));
    value.handleFrame({ type: "file.complete", id: "incoming-1" });
    const url = item(value, "incoming-1")?.objectUrl;
    expect(url).toBeTruthy();
    value.clear();
    value.clear();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(url);
    expect(items(value)).toEqual([]);
  });

  it("does not recreate state when asynchronous sends finish after clear", async () => {
    const value = manager();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const frames: FileFrame[] = [];
    value.setTransport({
      chunkSize: CHUNK_SIZE,
      send: async (frame) => {
        frames.push(frame);
        await pending;
        return true;
      },
    });
    value.enqueue([new File(["pending"], "late.txt")], device);
    const id = items(value)[0].id;
    value.clear();
    release();
    await flush();
    value.handleFrame({ type: "file.ack", id });
    expect(items(value)).toEqual([]);
    expect(frames.map((frame) => frame.type)).toEqual(["file.start"]);
  });
});
