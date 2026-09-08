import { useState, useEffect } from "react";
import { loadOrCreateIdentity } from "../lib/device";
import type { DeviceIdentity } from "../types/index";

/**
 * Returns the stable device identity for this browser instance.
 * Initializes immediately with loadOrCreateIdentity() via lazy useState,
 * and also calls loadOrCreateIdentity() once on mount via useEffect.
 *
 * Validates Requirements: 1.1, 1.2, 1.3, 1.4
 */
export function useDevice(): DeviceIdentity {
  const [identity, setIdentity] = useState<DeviceIdentity>(() =>
    loadOrCreateIdentity()
  );

  useEffect(() => {
    setIdentity(loadOrCreateIdentity());
  }, []);

  return identity;
}
