import { createContext, useContext, useEffect, type ReactNode } from "react";
import { clearStoredIdentity } from "../lib/device";
import { useDevice } from "../hooks/useDevice";
import { useFileTransfer } from "../hooks/useFileTransfer";
import type { FileItem, FileSelectionResult, FileTransfer } from "../types/files";
import { useSession, type UseSessionResult } from "../hooks/useSession";
import type { DeviceIdentity } from "../types";

interface SessionContextValue extends UseSessionResult {
  device: DeviceIdentity;
  hardResetApp: () => void;
  fileItems: FileItem[];
  fileTransfers: Map<string, FileTransfer>;
  enqueueFiles: (files: File[]) => FileSelectionResult;
  retryFile: (id: string) => boolean;
  cancelFile: (id: string) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const device = useDevice();
  const session = useSession();
  const { manager: files, fileItems, transfers: fileTransfers } = useFileTransfer();

  useEffect(() => {
    session.setFileFrameHandler((frame) => {
      files.setTransport(session.getFileTransport());
      files.handleFrame(frame);
    });
    return () => session.setFileFrameHandler(null);
  }, [files, session.setFileFrameHandler]);

  useEffect(() => {
    if (session.state === "EXPIRED") files.clear();
    else files.setTransport(session.getFileTransport());
  }, [files, session.state, session.dataChannelState, session.sessionId]);

  const createSession: UseSessionResult["createSession"] = async (...args) => {
    const result = await session.createSession(...args);
    if (result.ok) files.clear();
    return result;
  };
  const joinSession: UseSessionResult["joinSession"] = async (...args) => {
    files.clear();
    return session.joinSession(...args);
  };
  function reset() { files.clear(); session.reset(); }
  function disconnect() { files.connectionLost(); session.disconnect(); }
  function enqueueFiles(selected: File[]): FileSelectionResult {
    files.setTransport(session.getFileTransport());
    return files.enqueue(selected, device);
  }

  useEffect(() => {
    void session.resumeStoredSession(device.deviceName, device.deviceId);
  }, [device.deviceId, device.deviceName]);

  function hardResetApp() {
    reset();
    clearStoredIdentity();

    try {
      window.sessionStorage.clear();
    } catch {
      /* sessionStorage may be unavailable */
    }

    if (window.location.pathname === "/") {
      window.location.reload();
    } else {
      window.location.replace("/");
    }
  }

  return (
    <SessionContext.Provider value={{ ...session, createSession, joinSession, reset, disconnect, device, hardResetApp,
      fileItems, fileTransfers, enqueueFiles, retryFile: files.retry, cancelFile: files.cancel }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSessionContext(): SessionContextValue {
  const value = useContext(SessionContext);

  if (!value) {
    throw new Error("useSessionContext must be used inside SessionProvider");
  }

  return value;
}
