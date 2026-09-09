import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTransferWakeLock } from "./useTransferWakeLock";

let root: Root;
let host: HTMLDivElement;
let request: ReturnType<typeof vi.fn>;
const wakeLockDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "wakeLock",
);
const visibilityDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);

function sentinel() {
  const target = new EventTarget();
  return Object.assign(target, {
    released: false,
    release: vi.fn(async () => {
      target.dispatchEvent(new Event("release"));
    }),
  });
}

function Harness({ active }: { active: boolean }) {
  useTransferWakeLock(active);
  return null;
}

async function render(active: boolean, strict = false) {
  await act(async () => {
    const child = <Harness active={active} />;
    root.render(strict ? <StrictMode>{child}</StrictMode> : child);
  });
}

async function visibility(value: DocumentVisibilityState) {
  await act(async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  request = vi.fn().mockImplementation(async () => sentinel());
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: { request },
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  if (wakeLockDescriptor)
    Object.defineProperty(navigator, "wakeLock", wakeLockDescriptor);
  else Reflect.deleteProperty(navigator, "wakeLock");
  if (visibilityDescriptor)
    Object.defineProperty(document, "visibilityState", visibilityDescriptor);
  else Reflect.deleteProperty(document, "visibilityState");
});

describe("transfer wake lock", () => {
  it("requests only during active transfers and releases on completion", async () => {
    const lock = sentinel();
    request.mockResolvedValue(lock);
    await render(false);
    expect(request).not.toHaveBeenCalled();
    await render(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("screen");
    await render(true);
    expect(request).toHaveBeenCalledTimes(1);
    await render(false);
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it("releases when hidden and reacquires when visible", async () => {
    const first = sentinel();
    const second = sentinel();
    request.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await render(true);
    await visibility("hidden");
    expect(first.release).toHaveBeenCalledTimes(1);
    await visibility("visible");
    expect(request).toHaveBeenCalledTimes(2);
    await render(false);
    expect(second.release).toHaveBeenCalledTimes(1);
  });

  it("does not request while initially hidden", async () => {
    await visibility("hidden");
    await render(true);
    expect(request).not.toHaveBeenCalled();
    await visibility("visible");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("silently tolerates absent API and denied requests without retry loops", async () => {
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: undefined,
    });
    await render(true);
    await render(false);
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request },
    });
    request.mockRejectedValue(new Error("Denied"));
    await render(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("releases a request that settles after transfer completion", async () => {
    const lock = sentinel();
    let resolve!: (value: ReturnType<typeof sentinel>) => void;
    request.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render(true);
    await render(false);
    await act(async () => {
      resolve(lock);
    });
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("releases a stale pending request and reacquires after hide/show", async () => {
    const stale = sentinel();
    let resolve!: (value: ReturnType<typeof sentinel>) => void;
    request.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render(true);
    await visibility("hidden");
    await visibility("visible");
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(stale);
    });
    expect(stale.release).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("releases both stale StrictMode and current locks on cleanup", async () => {
    const first = sentinel();
    const second = sentinel();
    request.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await render(true, true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(second.release).not.toHaveBeenCalled();
    await act(async () => {
      root.render(null);
    });
    expect(second.release).toHaveBeenCalledTimes(1);
  });
});
