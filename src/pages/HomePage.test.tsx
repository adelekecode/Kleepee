import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomePage } from "./HomePage";

const session = vi.hoisted(() => ({
  createSession: vi.fn(),
  enqueueFiles: vi.fn(),
  reset: vi.fn(),
  device: { deviceName: "Local Fox", deviceId: "local-id" },
  error: null,
  isPending: false,
}));
vi.mock("../context/SessionContext", () => ({
  useSessionContext: () => session,
}));
vi.mock("../components/RecentSessions", () => ({ RecentSessions: () => null }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  session.createSession.mockResolvedValue({ ok: true });
  session.enqueueFiles.mockImplementation((files: File[]) => ({
    accepted: files,
    errors: [],
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/waiting" element={<p>Waiting screen</p>} />
        </Routes>
      </MemoryRouter>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
function attach(file: File) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("HomePage file sharing", () => {
  it("creates a files-only session and stages the file before showing the QR screen", async () => {
    const file = new File(["hello"], "hello.txt");
    attach(file);
    await submit();
    expect(session.createSession).toHaveBeenCalledWith(
      "",
      "Local Fox",
      "local-id",
      true,
    );
    expect(session.enqueueFiles).toHaveBeenCalledWith([file]);
    expect(host.textContent).toContain("Waiting screen");
  });

  it("preserves attachments and shows the create-session failure", async () => {
    session.createSession.mockResolvedValue({
      ok: false,
      error: { message: "Could not create a session." },
    });
    attach(new File(["hello"], "hello.txt"));
    await submit();
    expect(session.enqueueFiles).not.toHaveBeenCalled();
    expect(
      host.querySelector('[aria-label="Remove hello.txt"]'),
    ).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not create",
    );
  });

  it("rolls back a rejected queue without dropping selected files", async () => {
    session.enqueueFiles.mockReturnValue({
      accepted: [],
      errors: ["Too many queued files."],
    });
    attach(new File(["hello"], "hello.txt"));
    await submit();
    expect(session.reset).toHaveBeenCalledOnce();
    expect(
      host.querySelector('[aria-label="Remove hello.txt"]'),
    ).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Too many",
    );
  });

  it("exposes a labeled join action with its expanded state", () => {
    const join = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Join session"),
    )!;
    expect(join.getAttribute("aria-expanded")).toBe("false");
    act(() => join.click());
    expect(join.getAttribute("aria-expanded")).toBe("true");
    const label = [...host.querySelectorAll("label")].find(
      (element) => element.textContent?.trim() === "Session code or link",
    );
    expect(label).toBeDefined();
    const input = [...host.querySelectorAll("input")].find(
      (element) => element.id === label?.htmlFor,
    );
    expect(input).toBeDefined();
    expect(input?.placeholder).toBe("Enter 4 characters or paste a join link…");
  });
});
