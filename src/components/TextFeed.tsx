import { useEffect, useRef, useState } from "react";
import type { FeedItem } from "../types";
import type { FileTransfer } from "../types/files";
import { TextCard } from "./TextCard";
import { FileCard } from "./FileCard";

interface TextFeedProps {
  items: FeedItem[];
  transfers?: Map<string, FileTransfer>;
  onCancelTransfer?: (id: string) => void;
  onRetryTransfer?: (id: string) => void;
  onDropFiles?: (files: File[]) => void;
}

const SCROLL_TOLERANCE = 80;

export function TextFeed({
  items,
  transfers,
  onCancelTransfer,
  onRetryTransfer,
  onDropFiles,
}: TextFeedProps) {
  const feedRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const [hasNew, setHasNew] = useState(false);

  const byId = new Map<string, FeedItem>(items.map((item) => [item.id, item]));
  transfers?.forEach((transfer) => byId.set(transfer.id, transfer));
  const combinedItems = [...byId.values()].sort(
    (a, b) => a.timestamp - b.timestamp,
  );
  const totalCount = combinedItems.length;
  const itemIds = combinedItems.map((item) => item.id).join("|");

  function updateScrollPosition() {
    const el = feedRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < SCROLL_TOLERANCE;
    wasNearBottomRef.current = nearBottom;
    if (nearBottom) setHasNew(false);
  }

  function scrollToLatest(behavior: ScrollBehavior = "smooth") {
    const reduceMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    bottomRef.current?.scrollIntoView({
      behavior: reduceMotion ? "auto" : behavior,
      block: "end",
    });
    setHasNew(false);
  }

  useEffect(() => {
    if (wasNearBottomRef.current) {
      scrollToLatest(totalCount <= 1 ? "auto" : "smooth");
      return;
    }
    if (totalCount > 0) setHasNew(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemIds]);

  const isEmpty = totalCount === 0;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={feedRef}
        className="h-full max-h-[55dvh] min-h-[220px] overflow-y-auto focus:outline-none focus:ring-2 focus:ring-kleepee-focus rounded-[24px] border border-kleepee-border bg-kleepee-panel/75 p-3"
        onScroll={updateScrollPosition}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files"))
            event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (event.dataTransfer.files.length)
            onDropFiles?.(Array.from(event.dataTransfer.files));
        }}
        tabIndex={0}
        role="region"
        aria-label="Shared text and files"
      >
        {isEmpty ? (
          <div className="flex h-full min-h-[220px] items-center justify-center px-6 text-center text-sm leading-6 text-kleepee-muted">
            Shared text and files will appear here.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {combinedItems.map((item) =>
              item.type === "text" ? (
                <TextCard key={item.id} item={item} />
              ) : (
                <FileCard
                  key={item.id}
                  item={item}
                  onCancel={onCancelTransfer}
                  onRetry={onRetryTransfer}
                />
              ),
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {hasNew && (
        <button
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-kleepee-espresso px-4 py-2 text-sm font-medium text-white shadow-lg transition hover:bg-kleepee-buttonHover focus:outline-none focus:ring-2 focus:ring-kleepee-focus focus:ring-offset-2 focus:ring-offset-kleepee-bg"
          type="button"
          onClick={() => scrollToLatest()}
        >
          New item ↓
        </button>
      )}
    </div>
  );
}
