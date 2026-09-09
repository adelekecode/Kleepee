// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileTransferManager, TRANSFER_TIMEOUT_MS } from "./fileTransferManager";
import type { FileFrame } from "../types/files";

const device = { deviceId: "resume-device", deviceName: "Calm Otter" };
const managers: FileTransferManager[] = [];
function manager() {
  const value = new FileTransferManager();
  managers.push(value);
  return value;
}
function items(value: FileTransferManager) {
  return [...value.getSnapshot().transfers.values(), ...value.getSnapshot().fileItems];
}
async function flush() {
  for (let i = 0; i < 120; i++) await Promise.resolve();
}
interface LinkOptions {
  chunkSize?: number;
  stopAfterChunk?: number;
  dropFirstAck?: boolean;
  resumeOffset?: number;
}
function connect(sender: FileTransferManager, receiver: FileTransferManager, options: LinkOptions = {}) {
  const sent: FileFrame[] = [];
  const replies: FileFrame[] = [];
  let dropped = false;
  const chunkSize = options.chunkSize ?? 2048;
  // Install receiving transport first: reconnecting a sender automatically starts its queue.
  receiver.setTransport({
    chunkSize,
    send: async (frame, signal) => {
      if (signal.aborted) return false;
      replies.push(frame);
      if (options.dropFirstAck && !dropped && frame.type === "file.ack") {
        dropped = true;
        return true;
      }
      sender.handleFrame(frame.type === "file.resume.ready" && options.resumeOffset !== undefined
        ? { ...frame, nextIndex: options.resumeOffset }
        : frame);
      return true;
    },
  });
  sender.setTransport({
    chunkSize,
    send: async (frame, signal) => {
      if (signal.aborted) return false;
      sent.push(frame);
      receiver.handleFrame(frame);
      if (frame.type === "file.chunk" && frame.index === options.stopAfterChunk) {
        sender.connectionLost();
        receiver.connectionLost();
      }
      return true;
    },
  });
  return { sent, replies };
}
function enqueue(sender: FileTransferManager) {
  const bytes = Uint8Array.from({ length: 6 * 2048 + 17 }, (_, index) => (index * 31) % 251);
  const file = new File([bytes], "resume.custom");
  vi.spyOn(file, "slice").mockImplementation((start, end) => ({
    arrayBuffer: async () => bytes.slice(start, end).buffer,
  }) as Blob);
  expect(sender.enqueue([file], device).errors).toEqual([]);
  return { bytes, id: items(sender)[0].id };
}
async function interrupted() {
  const sender = manager();
  const receiver = manager();
  const initial = connect(sender, receiver, { stopAfterChunk: 1 });
  const file = enqueue(sender);
  await flush();
  expect(items(sender)[0].status).toBe("paused");
  expect(items(receiver)[0]).toMatchObject({ status: "paused", receivedChunks: 2 });
  expect(items(receiver)[0].objectUrl).toBeUndefined();
  return { sender, receiver, initial, ...file };
}
function chunkIndices(frames: FileFrame[]) {
  return frames.filter((frame) => frame.type === "file.chunk").map((frame) => frame.index);
}
async function assertDownload(receiver: FileTransferManager, bytes: Uint8Array) {
  const received = items(receiver);
  expect(received).toHaveLength(1);
  expect(received[0].status).toBe("complete");
  expect(new Uint8Array(await (await fetch(received[0].objectUrl!)).arrayBuffer())).toEqual(bytes);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  managers.splice(0).forEach((value) => value.clear());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("file transfer reconnect and resume", () => {
  it("retains the same transfer ID and sends only chunks after the receiver's verified prefix", async () => {
    const { sender, receiver, initial, id, bytes } = await interrupted();
    // Receiver accepted index 1 before the disconnect, even though the sender never got its send result.
    expect(chunkIndices(initial.sent)).toEqual([0, 1]);
    const resumed = connect(sender, receiver);
    await flush();
    expect(resumed.sent[0]).toMatchObject({ type: "file.resume", id });
    expect(resumed.replies[0]).toMatchObject({ type: "file.resume.ready", id, nextIndex: 2 });
    expect(chunkIndices(resumed.sent)).toEqual([2, 3, 4, 5, 6]);
    expect(resumed.sent.every((frame) => frame.id === id)).toBe(true);
    expect(items(sender)).toHaveLength(1);
    expect(items(sender)[0]).toMatchObject({ id, status: "complete" });
    await assertDownload(receiver, bytes);
  });

  it("restarts at zero when the receiver cleared temporary file data", async () => {
    const { sender, receiver, id, bytes } = await interrupted();
    receiver.clear();
    const resumed = connect(sender, receiver);
    await flush();
    expect(resumed.replies[0]).toMatchObject({ type: "file.resume.ready", id, nextIndex: 0 });
    expect(chunkIndices(resumed.sent)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(items(sender)[0].status).toBe("complete");
    await assertDownload(receiver, bytes);
  });

  it("restarts at zero with new chunk boundaries when the recovered transport permits smaller chunks", async () => {
    const { sender, receiver, id, bytes } = await interrupted();
    const resumed = connect(sender, receiver, { chunkSize: 1024 });
    await flush();
    expect(resumed.sent[0]).toMatchObject({ type: "file.resume", id, chunkSize: 1024, totalChunks: 13 });
    expect(resumed.replies[0]).toMatchObject({ type: "file.resume.ready", id, nextIndex: 0 });
    expect(chunkIndices(resumed.sent)).toEqual(Array.from({ length: 13 }, (_, index) => index));
    expect(items(sender)[0].status).toBe("complete");
    await assertDownload(receiver, bytes);
  });

  it("recovers a lost final acknowledgement without retransmitting chunks or creating another download", async () => {
    const sender = manager();
    const receiver = manager();
    const createUrl = vi.spyOn(URL, "createObjectURL");
    const frames = connect(sender, receiver, { dropFirstAck: true });
    const { id, bytes } = enqueue(sender);
    await flush();
    expect(items(sender)[0].status).toBe("sending");
    expect(items(receiver)[0].status).toBe("complete");
    const url = items(receiver)[0].objectUrl;
    await vi.advanceTimersByTimeAsync(TRANSFER_TIMEOUT_MS);
    await flush();
    expect(frames.sent.filter((frame) => frame.type === "file.resume")).toHaveLength(1);
    expect(frames.replies).toContainEqual(expect.objectContaining({ type: "file.resume.ready", id, nextIndex: 7 }));
    expect(chunkIndices(frames.sent)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(items(sender)[0].status).toBe("complete");
    expect(items(receiver)[0].objectUrl).toBe(url);
    expect(createUrl).toHaveBeenCalledTimes(1);
    await assertDownload(receiver, bytes);
  });

  it("does not resume a paused outgoing transfer after it is cancelled", async () => {
    const { sender, receiver, id } = await interrupted();
    sender.cancel(id);
    const resumed = connect(sender, receiver);
    await flush();
    expect(items(sender)[0]).toMatchObject({ status: "cancelled", canRetry: false });
    expect(resumed.sent).toEqual([]);
    expect(items(receiver)[0].objectUrl).toBeUndefined();
  });

  it("honors receiver cancellation while offline when the sender attempts to resume", async () => {
    const { sender, receiver, id } = await interrupted();
    receiver.cancel(id);
    const resumed = connect(sender, receiver);
    await flush();
    expect(resumed.replies).toContainEqual({ type: "file.reject", id });
    expect(chunkIndices(resumed.sent)).toEqual([]);
    expect(items(sender)[0].status).toBe("failed");
    expect(items(receiver)[0].status).toBe("cancelled");
    expect(items(receiver)[0].objectUrl).toBeUndefined();
  });

  it.each([-1, 0.5, 8, Number.NaN, Infinity])("rejects an invalid resume offset %s without sending chunks", async (resumeOffset) => {
    const { sender, receiver } = await interrupted();
    const resumed = connect(sender, receiver, { resumeOffset });
    await flush();
    expect(items(sender)[0]).toMatchObject({ status: "failed", canRetry: true });
    expect(chunkIndices(resumed.sent)).toEqual([]);
    expect(items(receiver)[0].objectUrl).toBeUndefined();
  });
});
