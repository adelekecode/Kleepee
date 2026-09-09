import type { TextItem } from "../types";

const HISTORY_KEY = "kleepee.session.history";
const MAX_ENTRIES = 10;

export interface SessionHistoryEntry {
  sessionId: string;
  sessionSecret: string;
  peerDeviceName: string | null;
  role: "initiator" | "joiner";
  itemCount: number;
  lastItemPreview: string | null;
  startedAt: number;
  endedAt: number;
}

export function readSessionHistory(): SessionHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry);
  } catch {
    return [];
  }
}

function isValidEntry(value: unknown): value is SessionHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<SessionHistoryEntry>;
  return (
    typeof e.sessionId === "string" &&
    typeof e.sessionSecret === "string" &&
    (e.role === "initiator" || e.role === "joiner") &&
    typeof e.itemCount === "number" &&
    typeof e.startedAt === "number" &&
    typeof e.endedAt === "number"
  );
}

export function recordSession(
  sessionId: string,
  sessionSecret: string,
  role: "initiator" | "joiner",
  peerDeviceName: string | null,
  items: TextItem[],
  startedAt: number,
): void {
  try {
    const history = readSessionHistory();
    // Avoid duplicate entries for the same session
    const filtered = history.filter((e) => e.sessionId !== sessionId);
    const lastItem = items.length > 0 ? items[items.length - 1] : null;
    const entry: SessionHistoryEntry = {
      sessionId,
      sessionSecret,
      role,
      peerDeviceName,
      itemCount: items.length,
      lastItemPreview: lastItem
        ? lastItem.content.slice(0, 80) +
          (lastItem.content.length > 80 ? "…" : "")
        : null,
      startedAt,
      endedAt: Date.now(),
    };
    const updated = [entry, ...filtered].slice(0, MAX_ENTRIES);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  } catch {
    /* localStorage may be unavailable */
  }
}

export function clearSessionHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* ignore */
  }
}
