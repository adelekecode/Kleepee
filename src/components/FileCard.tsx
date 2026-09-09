import type { FileItem, FileTransfer } from "../types/files";
import { formatFileSize } from "../lib/fileTransfer";

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

interface FileCardProps {
  item: FileItem;
  onCancel?: (id: string) => void;
  onRetry?: (id: string) => void;
}

export function FileCard({ item, onCancel, onRetry }: FileCardProps) {
  const active =
    item.status === "queued" ||
    item.status === "sending" ||
    item.status === "receiving";
  const pct = Math.max(
    0,
    Math.min(100, Math.round((item.progress ?? 0) * 100)),
  );
  const status = {
    queued: "Queued",
    sending: pct === 100 ? "Confirming delivery…" : "Sending",
    receiving: "Receiving",
    complete: "Complete",
    failed: "Transfer failed",
    cancelled: "Cancelled",
  }[item.status];
  return (
    <article className="rounded-[18px] border border-kleepee-border bg-kleepee-surface p-4 shadow-kleepee">
      <div className="flex items-center justify-between gap-4 text-xs text-kleepee-muted">
        <span className="truncate font-medium text-kleepee-espresso">
          {item.senderName}
        </span>
        <time
          className="shrink-0"
          dateTime={new Date(item.timestamp).toISOString()}
        >
          {relativeTime(item.timestamp)}
        </time>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-kleepee-panel text-kleepee-muted"
          aria-hidden="true"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M14 2H5a1 1 0 0 0-1 1v18a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8z" />
            <path d="M14 2v6h6M8 13h8M8 17h5" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-all text-sm font-medium text-kleepee-espresso">
            {item.fileName}
          </p>
          <p className="mt-1 text-xs text-kleepee-muted">
            {formatFileSize(item.fileSize)}
          </p>
        </div>
      </div>
      {active && item.status !== "queued" && (
        <div
          className="mt-4 h-1.5 overflow-hidden rounded-full bg-kleepee-panel"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Transfer progress for ${item.fileName}`}
        >
          <div
            className="h-full rounded-full bg-kleepee-espresso transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p
          className={`text-sm ${item.status === "failed" ? "text-kleepee-danger" : "text-kleepee-muted"}`}
        >
          {status}
          {active && item.status !== "queued" ? ` · ${pct}%` : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          {active && onCancel && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => onCancel(item.id)}
            >
              Cancel
            </button>
          )}
          {item.status === "failed" && item.canRetry && onRetry && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => onRetry(item.id)}
            >
              Retry
            </button>
          )}
          {item.status === "complete" && item.objectUrl && (
            <a
              className="btn-secondary"
              href={item.objectUrl}
              download={item.fileName}
            >
              Download
            </a>
          )}
        </div>
      </div>
      {item.error && (
        <p className="mt-2 text-sm leading-6 text-kleepee-danger">
          {item.error}
        </p>
      )}
    </article>
  );
}

export function TransferCard({
  transfer,
  onCancel,
}: {
  transfer: FileTransfer;
  onCancel: (id: string) => void;
}) {
  return <FileCard item={transfer} onCancel={onCancel} />;
}
