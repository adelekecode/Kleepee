import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, useSessionContext } from "./SessionContext";

const mocks = vi.hoisted(() => ({ reset: vi.fn(), resume: vi.fn(), handler: vi.fn() }));
vi.mock("../hooks/useDevice", () => ({ useDevice: () => ({ deviceId: "stable-id", deviceName: "Stable Fox" }) }));
vi.mock("../hooks/useSession", () => ({ useSession: () => ({
  state: "WAITING", sessionId: null, dataChannelState: null,
  reset: mocks.reset, resumeStoredSession: mocks.resume,
  getFileTransport: () => null, setFileFrameHandler: mocks.handler,
}) }));

let root: Root;
let host: HTMLDivElement;
let context: ReturnType<typeof useSessionContext>;
function Draft() {
  const [text, setText] = useState("");
  return <input aria-label="Draft" value={text} onChange={(event) => setText(event.target.value)} />;
}
function Probe() {
  context = useSessionContext();
  const location = useLocation();
  return <><output>{location.pathname}#{location.hash}</output><span>{context.device.deviceName}</span>
    <Draft key={context.resetVersion} /><button onClick={context.hardResetApp}>Reset</button></>;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.clear(); sessionStorage.clear();
  mocks.reset.mockImplementation(() => sessionStorage.removeItem("kleepee.session.current"));
  mocks.resume.mockResolvedValue({ ok: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<MemoryRouter initialEntries={["/connected#secret"]}><SessionProvider><Probe /></SessionProvider></MemoryRouter>));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

function editDraft(value: string) {
  const input = host.querySelector("input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Reset app", () => {
  it("forgets session/history/files and drafts while preserving device identity and unrelated storage", async () => {
    localStorage.setItem("kleepee.session.history", JSON.stringify([{ sessionSecret: "old-secret" }]));
    localStorage.setItem("kleepee.device.id", "stable-id");
    localStorage.setItem("kleepee.device.name", "Stable Fox");
    localStorage.setItem("unrelated-setting", "keep");
    sessionStorage.setItem("kleepee.session.current", "old-session");
    sessionStorage.setItem("unrelated-tab-state", "keep");
    editDraft("unsent draft");
    act(() => { context.enqueueFiles([new File(["file bytes"], "queued.bin")]); });
    expect(context.fileTransfers.size).toBe(1);
    expect(host.querySelector("input")!.value).toBe("unsent draft");

    await act(async () => { host.querySelector("button")!.click(); });
    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem("kleepee.session.current")).toBeNull();
    expect(localStorage.getItem("kleepee.session.history")).toBeNull();
    expect(context.fileTransfers.size).toBe(0);
    expect(context.fileItems).toEqual([]);
    expect(host.querySelector("input")!.value).toBe("");
    expect(host.querySelector("output")!.textContent).toBe("/#");
    expect(context.device.deviceId).toBe("stable-id");
    expect(localStorage.getItem("kleepee.device.id")).toBe("stable-id");
    expect(localStorage.getItem("kleepee.device.name")).toBe("Stable Fox");
    expect(localStorage.getItem("unrelated-setting")).toBe("keep");
    expect(sessionStorage.getItem("unrelated-tab-state")).toBe("keep");
  });

  it("resets a draft even when already on Home, without a page reload", async () => {
    await act(async () => { context.hardResetApp(); });
    editDraft("another draft");
    const version = context.resetVersion;
    await act(async () => { context.hardResetApp(); });
    expect(context.resetVersion).toBe(version + 1);
    expect(host.querySelector("input")!.value).toBe("");
    expect(host.querySelector("output")!.textContent).toBe("/#");
  });

  it("still resets files and UI when recent-history storage is unavailable", async () => {
    mocks.reset.mockImplementation(() => {});
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
    act(() => { context.enqueueFiles([new File([], "empty")]); });
    await act(async () => { context.hardResetApp(); });
    expect(context.fileTransfers.size).toBe(0);
    expect(host.querySelector("output")!.textContent).toBe("/#");
  });
});
