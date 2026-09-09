import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useNotifications, type UseNotificationsResult } from "./useNotifications";
import * as notifications from "../lib/notifications";

vi.mock("../lib/notifications", () => ({
  systemNotificationsSupported: vi.fn(() => true),
  getNotificationPermission: vi.fn(() => "granted"),
  requestNotificationPermission: vi.fn(async () => "granted"),
  showMessageNotification: vi.fn(async () => true),
  playMessageSound: vi.fn(), unlockAudio: vi.fn(),
  isSoundEnabled: vi.fn(() => true), setSoundEnabled: vi.fn(),
}));

let root: Root;
let host: HTMLDivElement;
let result: UseNotificationsResult;
const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
const item = { id: "1", type: "text" as const, senderId: "peer", senderName: "Fox", content: "Hello", timestamp: 1 };
function Harness() { result = useNotifications(); return null; }
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.mocked(notifications.showMessageNotification).mockResolvedValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<Harness />); });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  if (visibilityDescriptor) Object.defineProperty(document, "visibilityState", visibilityDescriptor);
  else Reflect.deleteProperty(document, "visibilityState");
});

describe("useNotifications", () => {
  it("never asks permission automatically or notifies self messages", async () => {
    expect(notifications.requestNotificationPermission).not.toHaveBeenCalled();
    await act(async () => { result.notify(item, "peer"); });
    expect(notifications.showMessageNotification).not.toHaveBeenCalled();
    expect(notifications.playMessageSound).not.toHaveBeenCalled();
  });

  it("uses toast fallback when actual OS display fails", async () => {
    vi.mocked(notifications.showMessageNotification).mockResolvedValue(false);
    await act(async () => { result.notify(item, "self"); });
    expect(result.toast?.preview).toBe("Hello");
  });

  it("does not duplicate a successfully displayed OS notification with a toast", async () => {
    await act(async () => { result.notify(item, "self"); });
    expect(notifications.showMessageNotification).toHaveBeenCalledWith("Fox", "Hello");
    expect(result.toast).toBeNull();
  });

  it("uses an in-app toast directly while visible", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => { result.notify(item, "self"); });
    expect(result.toast?.preview).toBe("Hello");
    expect(notifications.showMessageNotification).not.toHaveBeenCalled();
  });

  it("cleans the toast timer on unmount", async () => {
    vi.useFakeTimers();
    vi.mocked(notifications.showMessageNotification).mockResolvedValue(false);
    await act(async () => { result.notify(item, "self"); });
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => { root.render(null); });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes permissions after returning from settings", async () => {
    vi.mocked(notifications.getNotificationPermission).mockReturnValueOnce("denied");
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(result.permission).toBe("denied");
  });
});
