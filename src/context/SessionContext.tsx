import { createContext, useContext, type ReactNode } from "react";
import { useDevice } from "../hooks/useDevice";
import { useSession, type UseSessionResult } from "../hooks/useSession";
import type { DeviceIdentity } from "../types";

interface SessionContextValue extends UseSessionResult {
  device: DeviceIdentity;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const device = useDevice();
  const session = useSession();

  return (
    <SessionContext.Provider value={{ ...session, device }}>
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
