// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CHUNK_SIZE, decodeFileFrame, encodeFileFrame, isValidStartFrame, MAX_FILE_BYTES, planChunks, readChunk, validateFile } from "./fileTransfer";
import { decryptBytes, deriveKey, encryptBytes, generateSessionSecret } from "./crypto";
import type { FileStartFrame } from "../types/files";

const start: FileStartFrame = {
  type: "file.start", id: "file-1", senderId: "device-1", senderName: "Calm Otter", timestamp: 1,
  fileName: "archive.bin", fileSize: 100, mimeType: "application/octet-stream", totalChunks: 1, chunkSize: CHUNK_SIZE,
};

describe("file validation and chunk planning", () => {
  it("accepts arbitrary file types, empty files, and the exact 25 MiB limit", () => {
    expect(validateFile(new File([], "empty.exe"))).toBeNull();
    expect(validateFile(new File([new Uint8Array(MAX_FILE_BYTES)], "full.custom", { type: "application/custom" }))).toBeNull();
    expect(validateFile(new File([new Uint8Array(MAX_FILE_BYTES + 1)], "oversized.bin"))).toMatch(/25 MB/);
  });

  it("rejects missing and oversized names", () => {
    expect(validateFile(new File([], ""))).not.toBeNull();
    expect(validateFile(new File([], "x".repeat(256)))).not.toBeNull();
  });

  it("plans the final partial chunk and reads exact binary content", async () => {
    const bytes = Uint8Array.from({ length: CHUNK_SIZE + 3 }, (_, index) => index % 256);
    const file = new File([bytes], "all-bytes.bin");
    expect(planChunks({ size: 0 })).toBe(0);
    expect(planChunks({ size: CHUNK_SIZE })).toBe(1);
    expect(planChunks(file)).toBe(2);
    expect(await readChunk(file, 0)).toEqual(bytes.slice(0, CHUNK_SIZE));
    expect(await readChunk(file, 1)).toEqual(bytes.slice(CHUNK_SIZE));
    expect(planChunks({ size: 9 }, 4)).toBe(3);
  });
});

describe("incoming metadata validation", () => {
  it("accepts zero and maximum-sized metadata", () => {
    expect(isValidStartFrame(start)).toBe(true);
    expect(isValidStartFrame({ ...start, fileSize: 0, totalChunks: 0 })).toBe(true);
    expect(isValidStartFrame({ ...start, fileSize: MAX_FILE_BYTES, totalChunks: 400 })).toBe(true);
  });

  it.each([
    { fileSize: -1 }, { fileSize: 1.5 }, { fileSize: Infinity }, { fileSize: MAX_FILE_BYTES + 1 },
    { fileSize: "100" }, { totalChunks: 2 }, { totalChunks: -1 }, { totalChunks: 1.5 },
    { chunkSize: 0 }, { chunkSize: 1023 }, { chunkSize: CHUNK_SIZE + 1 }, { chunkSize: 1.5 },
    { timestamp: -1 }, { timestamp: 1.5 }, { timestamp: NaN }, { timestamp: 8.64e15 + 1 },
    { fileName: "" }, { fileName: "x".repeat(256) }, { mimeType: "" },
    { senderName: "x".repeat(129) }, { senderId: "" }, { id: "../file" }, { id: "x".repeat(65) },
  ])("rejects malformed start fields %j", (patch) => {
    expect(isValidStartFrame({ ...start, ...patch })).toBe(false);
  });
});

describe("encrypted binary frames", () => {
  it("preserves binary bytes without base64 inflation, including sliced input buffers", async () => {
    const data = Uint8Array.from({ length: CHUNK_SIZE }, (_, index) => index % 256);
    const frame = { type: "file.chunk" as const, id: "file-1", index: 0, data };
    const encoded = encodeFileFrame(frame);
    expect(encoded.byteLength - data.byteLength).toBeLessThan(100);
    expect(encoded.slice(-data.byteLength)).toEqual(data);
    const padded = new Uint8Array(encoded.length + 7);
    padded.set(encoded, 3);
    expect(decodeFileFrame(padded.subarray(3, 3 + encoded.length))).toEqual(frame);
    const key = await deriveKey(generateSessionSecret());
    const ciphertext = await encryptBytes(key, encoded);
    expect(ciphertext.length).toBe(encoded.length + 28);
    expect(decodeFileFrame(await decryptBytes(key, ciphertext))).toEqual(frame);
    ciphertext[ciphertext.length - 1] ^= 1;
    await expect(decryptBytes(key, ciphertext)).rejects.toThrow();
  });

  it("round trips metadata and rejects truncated or oversized binary envelopes", () => {
    const bytes = encodeFileFrame(start);
    expect(decodeFileFrame(bytes)).toEqual(start);
    expect(decodeFileFrame(new TextEncoder().encode('{"type":"text"}'))).toBeNull();
    expect(() => decodeFileFrame(bytes.slice(0, 5))).toThrow();
    expect(() => decodeFileFrame(bytes.slice(0, -1))).toThrow();
    const oversized = bytes.slice();
    new DataView(oversized.buffer).setUint16(4, 4097);
    expect(() => decodeFileFrame(oversized)).toThrow();
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(decodeFileFrame(trailing)).toMatchObject({ type: "file.invalid" });
  });
});
