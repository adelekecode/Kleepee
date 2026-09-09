import type { FileFrame, FileStartFrame } from "../types/files";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const CHUNK_SIZE = 64 * 1024;
export const MAX_HEADER_BYTES = 4096;
export const FRAME_OVERHEAD = MAX_HEADER_BYTES + 6 + 28; // header length, marker, IV and GCM tag
const MAGIC = new Uint8Array([75, 76, 70, 49]); // KLF1

export function validateFile(file: File): string | null {
  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > MAX_FILE_BYTES
  ) {
    return "That file is too large. Maximum size is 25 MB.";
  }
  if (!file.name || file.name.length > 255)
    return "Use a filename between 1 and 255 characters.";
  if (file.type.length > 255) return "That file type is invalid.";
  return null;
}

export function planChunks(
  file: Pick<File, "size">,
  chunkSize = CHUNK_SIZE,
): number {
  return Math.ceil(file.size / chunkSize);
}

export async function readChunk(
  file: File,
  index: number,
  chunkSize = CHUNK_SIZE,
): Promise<Uint8Array> {
  return new Uint8Array(
    await file.slice(index * chunkSize, (index + 1) * chunkSize).arrayBuffer(),
  );
}

const boundedString = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
export const validFileId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
export function isValidStartFrame(value: unknown): value is FileStartFrame {
  if (!value || typeof value !== "object") return false;
  const f = value as FileStartFrame;
  return (
    f.type === "file.start" &&
    validFileId(f.id) &&
    boundedString(f.senderId, 128) &&
    boundedString(f.senderName, 128) &&
    boundedString(f.fileName, 255) &&
    boundedString(f.mimeType, 255) &&
    Number.isSafeInteger(f.timestamp) &&
    f.timestamp >= 0 &&
    f.timestamp <= 8.64e15 &&
    Number.isSafeInteger(f.fileSize) &&
    f.fileSize >= 0 &&
    f.fileSize <= MAX_FILE_BYTES &&
    Number.isSafeInteger(f.chunkSize) &&
    f.chunkSize >= 1024 &&
    f.chunkSize <= CHUNK_SIZE &&
    Number.isSafeInteger(f.totalChunks) &&
    f.totalChunks === planChunks({ size: f.fileSize }, f.chunkSize) &&
    f.totalChunks <= MAX_FILE_BYTES
  );
}

export function isFileFrame(value: unknown): value is FileFrame {
  if (!value || typeof value !== "object") return false;
  const f = value as FileFrame;
  return typeof f.type === "string" && f.type.startsWith("file.");
}

/** Binary envelope: KLF1 + uint16 JSON-header length + header + raw chunk bytes. */
export function encodeFileFrame(frame: FileFrame): Uint8Array {
  const { data, ...header } = frame as FileFrame & { data?: Uint8Array };
  const json = new TextEncoder().encode(JSON.stringify(header));
  if (json.length > MAX_HEADER_BYTES)
    throw new Error("File header is too large.");
  const output = new Uint8Array(6 + json.length + (data?.byteLength ?? 0));
  output.set(MAGIC);
  new DataView(output.buffer).setUint16(4, json.length);
  output.set(json, 6);
  if (data) output.set(data, 6 + json.length);
  return output;
}

export function decodeFileFrame(bytes: Uint8Array): unknown | null {
  if (!MAGIC.every((byte, i) => bytes[i] === byte)) return null;
  if (bytes.length < 6) throw new Error("Truncated file header.");
  const length = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint16(4);
  if (length > MAX_HEADER_BYTES || bytes.length < 6 + length)
    throw new Error("Invalid file header.");
  const header = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(6, 6 + length),
    ),
  );
  if (!header || typeof header !== "object" || Array.isArray(header))
    throw new Error("Invalid file frame.");
  if (header.type === "file.chunk")
    return { ...header, data: bytes.slice(6 + length) };
  if (bytes.length !== 6 + length) return { ...header, type: "file.invalid" };
  return header;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
