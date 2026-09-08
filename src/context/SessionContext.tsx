import { createContext, useContext, useEffect, type ReactNode } from "react";
import { clearStoredIdentity } from "../lib/device";
import { useDevice } from "../hooks/useDevice";
import { useSession, type UseSessionResult } from "../hooks/useSession";
import type { DeviceIdentity } from "../types";

interface SessionContextValue extends UseSessionResult {
  device: DeviceIdentity;
  hardResetApp: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const device = useDevice();
  const session = useSession();

  useEffect(() => {
    void session.resumeStoredSession(device.deviceName, device.deviceId);
  }, [device.deviceId, device.deviceName]);

  function hardResetApp() {
    session.reset();
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
    <SessionContext.Provider value={{ ...session, device, hardResetApp }}>
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
