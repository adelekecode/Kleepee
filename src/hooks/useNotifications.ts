import { useState, useCallback } from "react";
import {
  requestNotificationPermission,
  getNotificationPermission,
  showMessageNotification,
  playMessageSound,
  isSoundEnabled,
  setSoundEnabled,
} from "../lib/notifications";
import type { TextItem } from "../types";

export interface UseNotificationsResult {
  permission: NotificationPermission;
  soundEnabled: boolean;
  requestPermission: () => Promise<void>;
  notify: (item: TextItem, currentDeviceId: string) => void;
  toggleSound: () => void;
}

export function useNotifications(): UseNotificationsResult {
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    getNotificationPermission(),
  );
  const [soundEnabled, setSoundEnabledState] = useState(isSoundEnabled);

  const requestPermission = useCallback(async () => {
    const result = await requestNotificationPermission();
    setPermission(result);
  }, []);

  const notify = useCallback(
    (item: TextItem, currentDeviceId: string) => {
      // Only notify for messages from the peer, not our own sends.
      if (item.senderId === currentDeviceId) return;

      showMessageNotification(item.senderName, item.content);

      if (isSoundEnabled()) {
        playMessageSound();
      }
    },
    [],
  );

  const toggleSound = useCallback(() => {
    const next = !isSoundEnabled();
    setSoundEnabled(next);
    setSoundEnabledState(next);
  }, []);

  return { permission, soundEnabled, requestPermission, notify, toggleSound };
}
