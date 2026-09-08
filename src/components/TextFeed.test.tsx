import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextFeed } from "./TextFeed";
import { FileCard } from "./FileCard";
import type { FileItem, FileTransfer } from "../types/files";

let root: Root;
let host: HTMLDivElement;
const base: FileItem = { id: "file-id", type: "file", senderId: "sender", senderName: "Friendly Fox", timestamp: 1, fileName: "example.bin", fileSize: 123, mimeType: "application/octet-stream", status: "complete", progress: 1 };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("file feed", () => {
  it("keeps live files in chronological order alongside text without duplicate cards", () => {
    const live: FileTransfer = { ...base, status: "sending", progress: .5, totalChunks: 1, receivedChunks: 0 };
    act(() => root.render(<TextFeed items={[base, { id: "text", type: "text", senderId: "s", senderName: "Fox", timestamp: 2, content: "Later text" }]} transfers={new Map([[base.id, live]])} />));
    const cards = host.querySelectorAll("article");
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("Sending");
    expect(cards[1].textContent).toContain("Later text");
    expect(host.querySelector('[role="region"]')?.getAttribute("tabindex")).toBe("0");
  });

  it("offers cancel for queued transfers and retry only for retryable failures", () => {
    const cancel = vi.fn();
    const retry = vi.fn();
    act(() => root.render(<FileCard item={{ ...base, status: "queued", progress: 0 }} onCancel={cancel} />));
    act(() => host.querySelector("button")!.click());
    expect(cancel).toHaveBeenCalledWith(base.id);
    act(() => root.render(<FileCard item={{ ...base, status: "failed", canRetry: true, error: "Connection interrupted" }} onRetry={retry} />));
    expect(host.textContent).toContain("Connection interrupted");
    act(() => host.querySelector("button")!.click());
    expect(retry).toHaveBeenCalledWith(base.id);
    act(() => root.render(<FileCard item={{ ...base, status: "failed", canRetry: false }} onRetry={retry} />));
    expect(host.querySelector("button")).toBeNull();
  });

  it("only exposes downloads for complete files and keeps long names readable", () => {
    const fileName = "a".repeat(300) + ".html";
    act(() => root.render(<FileCard item={{ ...base, status: "receiving", fileName, objectUrl: "blob:partial" }} />));
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toContain(fileName);
    expect(host.querySelector("p.break-all")).not.toBeNull();
    act(() => root.render(<FileCard item={{ ...base, fileName, objectUrl: "blob:complete" }} />));
    expect(host.querySelector("a")?.getAttribute("download")).toBe(fileName);
  });
});
