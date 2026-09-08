import { useEffect, useRef, useState } from "react";
import type { TextItem } from "../types";
import { TextCard } from "./TextCard";

interface TextFeedProps {
  items: TextItem[];
}

const SCROLL_TOLERANCE = 80;

export function TextFeed({ items }: TextFeedProps) {
  const feedRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const [hasNewText, setHasNewText] = useState(false);

  function updateScrollPosition() {
    const element = feedRef.current;
    if (!element) return;

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const nearBottom = distanceFromBottom < SCROLL_TOLERANCE;
    wasNearBottomRef.current = nearBottom;

    if (nearBottom) {
      setHasNewText(false);
    }
  }

  function scrollToLatest(behavior: ScrollBehavior = "smooth") {
    bottomRef.current?.scrollIntoView({ behavior, block: "end" });
    setHasNewText(false);
  }

  useEffect(() => {
    if (wasNearBottomRef.current) {
      scrollToLatest(items.length <= 1 ? "auto" : "smooth");
      return;
    }

    if (items.length > 0) {
      setHasNewText(true);
    }
  }, [items.length]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={feedRef}
        className="h-full overflow-y-auto rounded-[24px] border border-kleepee-border bg-kleepee-panel/75 p-3"
        onScroll={updateScrollPosition}
      >
        {items.length === 0 ? (
          <div className="flex h-full min-h-[220px] items-center justify-center px-6 text-center text-sm leading-6 text-kleepee-muted">
            Shared text will appear here.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {items.map((item) => (
              <TextCard key={item.id} item={item} />
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {hasNewText && (
        <button
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-kleepee-espresso px-4 py-2 text-sm font-medium text-white shadow-lg transition hover:bg-kleepee-buttonHover focus:outline-none focus:ring-2 focus:ring-kleepee-focus focus:ring-offset-2 focus:ring-offset-kleepee-bg"
          type="button"
          onClick={() => scrollToLatest()}
        >
          New text
        </button>
      )}
    </div>
  );
}
