import { useEffect, useRef } from "react";
import type { TextItem } from "../types";
import type { FileItem } from "../types/files";

/** Notify once per newly received item, including bursts delivered in one render. */
export function useIncomingNotifications(
  items: TextItem[],
  files: FileItem[],
  deviceId: string,
  notify: (item: TextItem, deviceId: string) => void,
) {
  const seen = useRef(new Set([
    ...items.map((item) => item.id),
    ...files.filter((item) => item.status === "complete").map((item) => item.id),
  ]));
  useEffect(() => {
    const received = [...items, ...files.filter((item) => item.status === "complete")]
      .sort((a, b) => a.timestamp - b.timestamp);
    for (const item of received) {
      if (seen.current.has(item.id)) continue;
      seen.current.add(item.id);
      if (item.senderId === deviceId) continue;
      notify({
        ...item,
        type: "text",
        content: item.type === "text" ? item.content : `📎 ${item.fileName}`,
      }, deviceId);
    }
  }, [items, files, deviceId, notify]);
}
