import { useState } from "react";
import { loadOrCreateIdentity } from "../lib/device";
import type { DeviceIdentity } from "../types";

export function useDevice(): DeviceIdentity {
  const [identity] = useState<DeviceIdentity>(() => loadOrCreateIdentity());
  return identity;
}
