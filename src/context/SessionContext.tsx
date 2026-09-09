import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { clearSessionHistory } from "../lib/sessionHistory";
import { useDevice } from "../hooks/useDevice";
import { useFileTransfer } from "../hooks/useFileTransfer";
import type {
  FileItem,
  FileSelectionResult,
  FileTransfer,
} from "../types/files";
import { useSession, type UseSessionResult } from "../hooks/useSession";
import type { DeviceIdentity } from "../types";

interface SessionContextValue extends UseSessionResult {
  device: DeviceIdentity;
  hardResetApp: () => void;
  resetVersion: number;
  fileItems: FileItem[];
  fileTransfers: Map<string, FileTransfer>;
  enqueueFiles: (files: File[]) => FileSelectionResult;
  retryFile: (id: string) => boolean;
  cancelFile: (id: string) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const device = useDevice();
  const navigate = useNavigate();
  const [resetVersion, setResetVersion] = useState(0);
  const session = useSession();
  const {
    manager: files,
    fileItems,
    transfers: fileTransfers,
  } = useFileTransfer();

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
  function reset() {
    files.clear();
    session.reset();
  }
  function disconnect() {
    files.connectionLost();
    session.disconnect();
  }
  function enqueueFiles(selected: File[]): FileSelectionResult {
    files.setTransport(session.getFileTransport());
    return files.enqueue(selected, device);
  }

  useEffect(() => {
    void session.resumeStoredSession(device.deviceName, device.deviceId);
  }, [device.deviceId, device.deviceName]);

  function hardResetApp() {
    reset();
    clearSessionHistory();
    // Remount route-local drafts too, without reloading or rotating the device
    // identity shared by other active tabs. Only the current session key is removed.
    setResetVersion((version) => version + 1);
    navigate("/", { replace: true });
  }

  return (
    <SessionContext.Provider
      value={{
        ...session,
        createSession,
        joinSession,
        reset,
        disconnect,
        device,
        hardResetApp,
        resetVersion,
        fileItems,
        fileTransfers,
        enqueueFiles,
        retryFile: files.retry,
        cancelFile: files.cancel,
      }}
    >
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
