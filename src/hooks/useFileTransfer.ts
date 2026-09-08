import { useEffect, useState, useSyncExternalStore } from "react";
import { FileTransferManager } from "../lib/fileTransferManager";

export function useFileTransfer() {
  const [manager] = useState(() => new FileTransferManager());
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  useEffect(() => () => manager.clear(), [manager]);
  return { ...state, manager };
}
