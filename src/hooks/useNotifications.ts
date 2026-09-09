import { useState, useCallback, useRef, useEffect } from "react";
import {
  requestNotificationPermission,
  getNotificationPermission,
  systemNotificationsSupported,
  showMessageNotification,
  playMessageSound,
  unlockAudio,
  isSoundEnabled,
  setSoundEnabled,
} from "../lib/notifications";
import type { TextItem } from "../types";

export interface InAppToast {
  id: number;
  senderName: string;
  preview: string;
}

export interface UseNotificationsResult {
  /** Whether system notifications are supported on this platform/browser */
  systemSupported: boolean;
  permission: NotificationPermission;
  soundEnabled: boolean;
  /** Active in-app toast (for mobile / no system notification support) */
  toast: InAppToast | null;
  requestPermission: () => Promise<void>;
  /** Call from any user gesture handler to unlock audio on mobile */
  unlockAudio: () => void;
  notify: (item: TextItem, currentDeviceId: string) => void;
  dismissToast: () => void;
  toggleSound: () => void;
}

let toastId = 0;

export function useNotifications(): UseNotificationsResult {
  const systemSupported = systemNotificationsSupported();

  const [permission, setPermission] = useState<NotificationPermission>(() =>
    getNotificationPermission(),
  );
  const [soundEnabled, setSoundEnabledState] = useState(isSoundEnabled);
  const [toast, setToast] = useState<InAppToast | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    const refreshPermission = () => setPermission(getNotificationPermission());
    window.addEventListener("focus", refreshPermission);
    document.addEventListener("visibilitychange", refreshPermission);
    return () => {
      mountedRef.current = false;
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      window.removeEventListener("focus", refreshPermission);
      document.removeEventListener("visibilitychange", refreshPermission);
    };
  }, []);

  const requestPermission = useCallback(async () => {
    const result = await requestNotificationPermission();
    if (mountedRef.current) setPermission(result);
  }, []);

  const showToast = useCallback((senderName: string, preview: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    const id = ++toastId;
    setToast({
      id,
      senderName,
      preview: preview.slice(0, 80) + (preview.length > 80 ? "…" : ""),
    });
    toastTimerRef.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const dismissToast = useCallback(() => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(null);
  }, []);

  const notify = useCallback(
    (item: TextItem, currentDeviceId: string) => {
      if (item.senderId === currentDeviceId) return;

      if (document.visibilityState === "visible") {
        showToast(item.senderName, item.content);
      } else {
        void showMessageNotification(item.senderName, item.content).then((shown) => {
          if (!shown && mountedRef.current) showToast(item.senderName, item.content);
        });
      }

      if (isSoundEnabled()) {
        playMessageSound();
      }
    },
    [showToast],
  );

  const toggleSound = useCallback(() => {
    const next = !isSoundEnabled();
    setSoundEnabled(next);
    setSoundEnabledState(next);
  }, []);

  return {
    systemSupported,
    permission,
    soundEnabled,
    toast,
    requestPermission,
    unlockAudio,
    notify,
    dismissToast,
    toggleSound,
  };
}
