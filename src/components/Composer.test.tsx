import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerResult } from "./Composer";
import { MAX_FILE_BYTES } from "../lib/fileTransfer";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function stage(files: File[]) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  act(() => { input.dispatchEvent(new Event("change", { bubbles: true })); });
}
function type(text: string) {
  const area = host.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}

describe("Composer", () => {
  it("removes only accepted attachments and shows rejection guidance", async () => {
    const first = new File(["one"], "one.txt");
    const second = new File(["two"], "two.txt");
    const onSubmit = vi.fn(async () => ({ textSent: false, accepted: [first], errors: ["Queue is full. Try again."] }));
    act(() => root.render(<Composer onSubmit={onSubmit} />));
    stage([first, second]);
    await submit();
    expect(host.querySelector('[aria-label="Remove one.txt"]')).toBeNull();
    expect(host.querySelector('[aria-label="Remove two.txt"]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Queue is full");
  });

  it("preserves new draft edits while an earlier message is pending", async () => {
    let resolve!: (result: ComposerResult) => void;
    const onSubmit = vi.fn(() => new Promise<ComposerResult>((done) => { resolve = done; }));
    act(() => root.render(<Composer onSubmit={onSubmit} />));
    type("First draft");
    await submit();
    expect(onSubmit).toHaveBeenCalledWith("First draft", []);
    type("Next draft");
    await act(async () => resolve({ textSent: true, accepted: [], errors: [] }));
    expect(host.querySelector("textarea")?.value).toBe("Next draft");
  });

  it("keeps both draft and files when submission throws", async () => {
    act(() => root.render(<Composer onSubmit={async () => { throw new Error("offline"); }} />));
    type("Keep me");
    stage([new File(["data"], "keep.bin")]);
    await submit();
    expect(host.querySelector("textarea")?.value).toBe("Keep me");
    expect(host.querySelector('[aria-label="Remove keep.bin"]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("still here");
  });

  it("accepts empty files and keeps valid files when another exceeds the size limit", async () => {
    const empty = new File([], "empty.txt");
    const oversized = new File([], "big.bin");
    Object.defineProperty(oversized, "size", { value: MAX_FILE_BYTES + 1 });
    const onSubmit = vi.fn(async () => ({ textSent: false, accepted: [empty], errors: [] }));
    act(() => root.render(<Composer onSubmit={onSubmit} />));
    stage([oversized, empty]);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("25 MB");
    expect(host.querySelector('[aria-label="Remove big.bin"]')).toBeNull();
    await submit();
    expect(onSubmit).toHaveBeenCalledWith("", [empty]);
  });

  it("blocks blank submissions and UTF-8 text beyond the byte limit", async () => {
    const onSubmit = vi.fn(async () => ({ textSent: true, accepted: [], errors: [] }));
    act(() => root.render(<Composer onSubmit={onSubmit} />));
    await submit();
    type("😀".repeat(16_385));
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(host.querySelector("textarea")?.getAttribute("aria-invalid")).toBe("true");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("65,536");
  });
});
