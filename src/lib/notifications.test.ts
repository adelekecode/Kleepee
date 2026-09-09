import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getNotificationPermission, requestNotificationPermission, showMessageNotification, systemNotificationsSupported } from "./notifications";

let NotificationMock: ReturnType<typeof vi.fn> & { permission: NotificationPermission; requestPermission: ReturnType<typeof vi.fn> };
let showNotification: ReturnType<typeof vi.fn>;
let getRegistration: ReturnType<typeof vi.fn>;
const swDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
const visibleDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
const standaloneDescriptor = Object.getOwnPropertyDescriptor(navigator, "standalone");

beforeEach(() => {
  NotificationMock = Object.assign(vi.fn(), { permission: "granted" as NotificationPermission, requestPermission: vi.fn().mockResolvedValue("granted") });
  vi.stubGlobal("Notification", NotificationMock);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  showNotification = vi.fn().mockResolvedValue(undefined);
  getRegistration = vi.fn().mockResolvedValue({ active: {}, showNotification });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration } });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [target, key, descriptor] of [
    [navigator, "serviceWorker", swDescriptor],
    [navigator, "standalone", standaloneDescriptor],
    [document, "visibilityState", visibleDescriptor],
  ] as const) {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
});

function ios(standalone = true) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
  Object.defineProperty(navigator, "standalone", { configurable: true, value: standalone });
}

describe("system notifications", () => {
  it("detects iOS standalone support without constructing notifications", () => {
    ios();
    NotificationMock.mockImplementation(() => { throw new TypeError("Illegal constructor"); });
    expect(systemNotificationsSupported()).toBe(true);
    expect(getNotificationPermission()).toBe("granted");
    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it("does not offer iOS notifications in regular browser tabs", () => {
    ios(false);
    expect(systemNotificationsSupported()).toBe(false);
  });

  it("requests permission synchronously before any registration lookup", async () => {
    ios();
    NotificationMock.permission = "default";
    const promise = requestNotificationPermission();
    expect(NotificationMock.requestPermission).toHaveBeenCalledTimes(1);
    expect(getRegistration).not.toHaveBeenCalled();
    expect(await promise).toBe("granted");
  });

  it("does not re-request permission that is already denied", async () => {
    NotificationMock.permission = "denied";
    expect(await requestNotificationPermission()).toBe("denied");
    expect(NotificationMock.requestPermission).not.toHaveBeenCalled();
  });

  it("uses registration.showNotification on iOS without the unsupported constructor", async () => {
    ios();
    expect(await showMessageNotification("Fox", "Hello")).toBe(true);
    expect(showNotification).toHaveBeenCalledWith("Message from Fox", expect.objectContaining({
      body: "Hello", icon: "/icon-192.png", data: { url: "/connected" },
    }));
    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it("returns failure for mobile without an active worker without hanging or constructor fallback", async () => {
    ios();
    getRegistration.mockResolvedValue(undefined);
    expect(await showMessageNotification("Fox", "Hello")).toBe(false);
    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it("returns actual display failure for toast fallback", async () => {
    showNotification.mockRejectedValue(new Error("Denied"));
    expect(await showMessageNotification("Fox", "Hello")).toBe(false);
  });

  it("shows no OS notification while visible or lacking permission", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    expect(await showMessageNotification("Fox", "Hello")).toBe(false);
    NotificationMock.permission = "denied";
    expect(await showMessageNotification("Fox", "Hello")).toBe(false);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("honors mute and truncates previews without persisting content in data", async () => {
    localStorage.setItem("kleepee.notifications.sound", "false");
    await showMessageNotification("Fox", "a".repeat(120));
    expect(showNotification).toHaveBeenCalledWith("Message from Fox", expect.objectContaining({ silent: true, body: "a".repeat(100) + "…", data: { url: "/connected" } }));
  });

  it("tolerates permission API failure", async () => {
    NotificationMock.permission = "default";
    NotificationMock.requestPermission.mockRejectedValue(new Error("Policy"));
    expect(await requestNotificationPermission()).toBe("default");
  });
});
