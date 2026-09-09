export type FileTransferStatus =
  | "queued"
  | "paused"
  | "sending"
  | "receiving"
  | "complete"
  | "failed"
  | "cancelled";

/** File bytes and object URLs are never persisted. */
export interface FileItem {
  id: string;
  type: "file";
  senderId: string;
  senderName: string;
  timestamp: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
  status: FileTransferStatus;
  progress: number;
  objectUrl?: string;
  canRetry?: boolean;
  error?: string;
}

export interface FileTransfer extends FileItem {
  totalChunks: number;
  receivedChunks: number;
}

export interface FileStartFrame {
  type: "file.start";
  id: string;
  senderId: string;
  senderName: string;
  timestamp: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
  chunkSize: number;
}
export interface FileChunkFrame {
  type: "file.chunk";
  id: string;
  index: number;
  data: Uint8Array;
}
export type FileFrame =
  | FileStartFrame
  | (Omit<FileStartFrame, "type"> & { type: "file.resume"; requestId: string })
  | { type: "file.resume.ready"; id: string; requestId: string; nextIndex: number }
  | FileChunkFrame
  | {
      type: "file.complete" | "file.cancel" | "file.ack" | "file.reject";
      id: string;
    };

export interface PreparedFileFrame {
  send: () => Promise<boolean>;
}

export interface FileTransport {
  chunkSize: number;
  send: (frame: FileFrame, signal: AbortSignal) => Promise<boolean>;
  /** Encrypt ahead of time; sending still occurs in file-chunk order. */
  prepare?: (
    frame: FileFrame,
    signal: AbortSignal,
  ) => Promise<PreparedFileFrame>;
}

export interface FileSelectionResult {
  accepted: File[];
  errors: string[];
}
