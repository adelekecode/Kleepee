import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backgroundTimeout } from "./backgroundTimeout";

let cancel: (() => void) | undefined;
let visibility = "visible";
beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
});
afterEach(() => {
  cancel?.();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("background-aware deadlines", () => {
  it("still expires a stalled visible page", () => {
    const expired = vi.fn();
    cancel = backgroundTimeout(expired, 15000);
    vi.advanceTimersByTime(15000);
    expect(expired).toHaveBeenCalledOnce();
  });
  it("does not expire while hidden and grants a full grace period when visible", () => {
    const expired = vi.fn();
    cancel = backgroundTimeout(expired, 15000);
    vi.advanceTimersByTime(10000);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(300000);
    expect(expired).not.toHaveBeenCalled();
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(14999);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledOnce();
  });
  it("survives a freeze/resume cycle even if visibility does not change", () => {
    const expired = vi.fn();
    cancel = backgroundTimeout(expired, 15000);
    document.dispatchEvent(new Event("freeze"));
    vi.advanceTimersByTime(60000);
    expect(expired).not.toHaveBeenCalled();
    document.dispatchEvent(new Event("resume"));
    vi.advanceTimersByTime(15000);
    expect(expired).toHaveBeenCalledOnce();
  });
  it("does not treat an overdue timer after an event-loop suspension as a failure", () => {
    const expired = vi.fn();
    cancel = backgroundTimeout(expired, 15000);
    vi.setSystemTime(Date.now() + 300000);
    vi.advanceTimersByTime(15000);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(15000);
    expect(expired).toHaveBeenCalledOnce();
  });
  it("respects a remote device's background state", () => {
    let hidden = true;
    const expired = vi.fn();
    cancel = backgroundTimeout(expired, 15000, () => hidden);
    vi.advanceTimersByTime(60000);
    expect(expired).not.toHaveBeenCalled();
    hidden = false;
    vi.advanceTimersByTime(15000);
    expect(expired).toHaveBeenCalledOnce();
  });
  it("removes its timer and listeners on cancel", () => {
    const expired = vi.fn();
    cancel = backgroundTimeout(expired, 15000);
    cancel();
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("resume"));
    window.dispatchEvent(new Event("pageshow"));
    expect(vi.getTimerCount()).toBe(0);
    expect(expired).not.toHaveBeenCalled();
  });
});
