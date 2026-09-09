import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { InstallApp } from "./InstallApp";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => { root.render(<InstallApp />); });
}

describe("InstallApp", () => {
  it("offers browser menu instructions only when requested", async () => {
    await render();
    expect(host.textContent).toBe("Install app");
    await act(async () => { host.querySelector("button")!.click(); });
    expect(host.textContent).toContain("Open your browser’s menu");
    expect(host.textContent).toContain("may still pause connections");
    expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => { host.querySelectorAll("button")[1].click(); });
    expect(host.textContent).toBe("Install app");
  });

  it("uses iOS home screen instructions", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
    await render();
    await act(async () => { host.querySelector("button")!.click(); });
    expect(host.textContent).toContain("In Safari, tap Share, then Add to Home Screen.");
  });

  it("invokes the deferred browser prompt only after a click and removes control on installation", async () => {
    await render();
    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome: "accepted" }),
    });
    await act(async () => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    await act(async () => { host.querySelector("button")!.click(); });
    expect(prompt).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new Event("appinstalled")); });
    expect(host.querySelector("button")).toBeNull();
  });

  it("does not reuse a dismissed prompt", async () => {
    await render();
    const prompt = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      window.dispatchEvent(Object.assign(new Event("beforeinstallprompt"), {
        prompt, userChoice: Promise.resolve({ outcome: "dismissed" }),
      }));
    });
    await act(async () => { host.querySelector("button")!.click(); });
    await act(async () => { host.querySelector("button")!.click(); });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Open your browser’s menu");
  });

  it("falls back to instructions when the browser prompt fails", async () => {
    await render();
    await act(async () => {
      window.dispatchEvent(Object.assign(new Event("beforeinstallprompt"), {
        prompt: vi.fn().mockRejectedValue(new Error("Not allowed")),
        userChoice: Promise.resolve({ outcome: "dismissed" }),
      }));
    });
    await act(async () => { host.querySelector("button")!.click(); });
    expect(host.textContent).toContain("Open your browser’s menu");
  });

  it("hides the control in standalone mode", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    await render();
    expect(host.querySelector("button")).toBeNull();
  });
});
