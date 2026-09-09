import { useEffect, useRef, useState } from "react";
import type { TextItem } from "../types";
import { copyToClipboard } from "../lib/clipboard";
import { classifyContent } from "../lib/contentType";

interface TextCardProps {
  item: TextItem;
}

function formatRelativeTime(timestamp: number): string {
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));

  if (diffSeconds < 60)
    return diffSeconds <= 1 ? "just now" : `${diffSeconds}s ago`;

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function TextCard({ item }: TextCardProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentType = classifyContent(item.content);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function handleCopy() {
    try {
      await copyToClipboard(item.content);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopyState("idle"), 2000);
  }

  function handleOpen() {
    window.open(item.content, "_blank", "noopener,noreferrer");
  }

  return (
    <article className="rounded-[18px] border border-kleepee-border bg-kleepee-surface p-4 shadow-kleepee transition duration-200 ease-out">
      <div className="flex items-center justify-between gap-4 text-xs text-kleepee-muted">
        <span className="truncate font-medium text-kleepee-espresso">
          {item.senderName}
        </span>
        <time dateTime={new Date(item.timestamp).toISOString()}>
          {formatRelativeTime(item.timestamp)}
        </time>
      </div>

      <p className="mt-3 whitespace-pre-wrap break-words text-[15px] leading-7 text-kleepee-espresso">
        {item.content}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button className="btn-secondary" type="button" onClick={handleCopy}>
          {copyState === "copied" ? "Copied!" : "Copy"}
        </button>

        {contentType === "url" && (
          <button className="btn-secondary" type="button" onClick={handleOpen}>
            Open
          </button>
        )}

        {copyState === "failed" && (
          <span className="text-xs text-kleepee-danger">
            Copy failed. Select the text manually.
          </span>
        )}
      </div>
    </article>
  );
}
