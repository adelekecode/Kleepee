import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { readSessionHistory, clearSessionHistory, type SessionHistoryEntry } from "../lib/sessionHistory";

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

interface RecentSessionsProps {
  /** Called before navigating back into a session so the parent can reset state */
  onResume?: (sessionId: string, sessionSecret: string) => void;
}

export function RecentSessions({ onResume }: RecentSessionsProps) {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<SessionHistoryEntry[]>([]);

  const refresh = useCallback(() => {
    setEntries(readSessionHistory());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (entries.length === 0) return null;

  function handleResume(entry: SessionHistoryEntry) {
    onResume?.(entry.sessionId, entry.sessionSecret);
    navigate(`/j/${encodeURIComponent(entry.sessionId)}#${entry.sessionSecret}`);
  }

  function handleClearAll() {
    clearSessionHistory();
    setEntries([]);
  }

  return (
    <section aria-label="Recent sessions">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-kleepee-muted">
          Recent sessions
        </p>
        <button
          type="button"
          className="text-xs text-kleepee-muted underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-kleepee-focus focus:ring-offset-1 rounded-sm"
          onClick={handleClearAll}
        >
          Clear all
        </button>
      </div>

      <ul className="flex flex-col gap-2" role="list">
        {entries.map((entry) => (
          <li key={entry.sessionId}>
            <button
              type="button"
              className="panel w-full text-left transition hover:border-kleepee-focus/40 hover:bg-kleepee-panel focus:outline-none focus:ring-2 focus:ring-kleepee-focus focus:ring-offset-2 focus:ring-offset-kleepee-bg"
              onClick={() => handleResume(entry)}
              aria-label={`Resume session with ${entry.peerDeviceName ?? "unknown device"}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-kleepee-espresso">
                    {entry.peerDeviceName ?? "Unknown device"}
                  </p>
                  {entry.lastItemPreview && (
                    <p className="mt-0.5 truncate text-xs text-kleepee-muted">
                      {entry.lastItemPreview}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs text-kleepee-muted">{formatRelativeTime(entry.endedAt)}</p>
                  {entry.itemCount > 0 && (
                    <p className="mt-0.5 text-xs text-kleepee-muted">
                      {entry.itemCount} {entry.itemCount === 1 ? "item" : "items"}
                    </p>
                  )}
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
