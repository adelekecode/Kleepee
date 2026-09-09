import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIncomingNotifications } from "./useIncomingNotifications";
import type { TextItem } from "../types";
import type { FileItem } from "../types/files";

const deviceId = "local-device";
const cleanups: Array<() => void> = [];
function text(id: string, timestamp = 1, senderId = "peer-device"): TextItem {
  return { id, type: "text", senderId, senderName: "Calm Otter", timestamp, content: `Text ${id}` };
}
function file(id: string, status: FileItem["status"] = "complete", timestamp = 1, senderId = "peer-device"): FileItem {
  return { id, type: "file", senderId, senderName: "Calm Otter", timestamp, fileName: `${id}.bin`,
    fileSize: 42, mimeType: "application/octet-stream", status, progress: status === "complete" ? 1 : 0 };
}
function renderNotifications(initialItems: TextItem[] = [], initialFiles: FileItem[] = []) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  const notify = vi.fn();
  function Probe(props: { items: TextItem[]; files: FileItem[]; callback: typeof notify }) {
    useIncomingNotifications(props.items, props.files, deviceId, props.callback);
    return null;
  }
  function render(items: TextItem[], files: FileItem[], callback = notify) {
    act(() => root.render(<StrictMode><Probe items={items} files={files} callback={callback} /></StrictMode>));
  }
  render(initialItems, initialFiles);
  cleanups.push(() => {
    act(() => root.unmount());
    element.remove();
  });
  return { notify, render };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("incoming message notification triggers", () => {
  it("does not notify for initial history or newly sent local text and files", () => {
    const history = text("history-text");
    const oldFile = file("history-file");
    const { notify, render } = renderNotifications([history], [oldFile]);
    expect(notify).not.toHaveBeenCalled();
    render([history, text("self-text", 2, deviceId)], [oldFile, file("self-file", "complete", 2, deviceId)]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies for every new incoming text in a batched render, once each", () => {
    const { notify, render } = renderNotifications();
    const items = [text("first", 1), text("second", 2), text("third", 3)];
    render(items, []);
    expect(notify).toHaveBeenCalledTimes(3);
    items.forEach((item, index) => expect(notify).toHaveBeenNthCalledWith(index + 1, item, deviceId));
    render([...items], []);
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("notifies only when an incoming file completes, including files already receiving on mount", () => {
    const initialReceiving = file("active-on-mount", "receiving");
    const { notify, render } = renderNotifications([], [initialReceiving]);
    const statuses: FileItem["status"][] = ["queued", "sending", "receiving", "paused", "failed", "cancelled"];
    const others = statuses.map((status) => file(status, status));
    render([], [initialReceiving, ...others]);
    expect(notify).not.toHaveBeenCalled();
    render([], [{ ...initialReceiving, status: "complete", progress: 1 }, ...others]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      id: "active-on-mount", type: "text", content: "📎 active-on-mount.bin", senderId: "peer-device",
    }), deviceId);
  });

  it("merges batched text and completed file arrivals in timestamp order without mutating feed arrays", () => {
    const { notify, render } = renderNotifications();
    const messages = [text("later-text", 40), text("earlier-text", 10)];
    const files = [file("later-file", "complete", 30), file("earlier-file", "complete", 20)];
    render(messages, files);
    expect(notify.mock.calls.map(([item]) => item.id)).toEqual(["earlier-text", "earlier-file", "later-file", "later-text"]);
    expect(notify.mock.calls.map(([item]) => item.timestamp)).toEqual([10, 20, 30, 40]);
    expect(messages.map((item) => item.id)).toEqual(["later-text", "earlier-text"]);
    expect(files.map((item) => item.id)).toEqual(["later-file", "earlier-file"]);
  });

  it("does not replay seen IDs after rerenders, callback changes, shrinking lists, or a retried file", () => {
    const { notify, render } = renderNotifications();
    const message = text("received-text");
    const complete = file("received-file");
    render([message], [complete]);
    expect(notify).toHaveBeenCalledTimes(2);
    render([], []);
    render([message], [{ ...complete, status: "receiving", progress: 0 }]);
    render([message], [complete]);
    const replacementNotify = vi.fn();
    render([{ ...message }], [{ ...complete }], replacementNotify);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(replacementNotify).not.toHaveBeenCalled();
  });

  it("recognizes new IDs after a count shrink and notifies when a previously failed file finishes retrying", () => {
    const { notify, render } = renderNotifications();
    render([text("old-1"), text("old-2"), text("old-3")], [file("retry", "failed")]);
    expect(notify).toHaveBeenCalledTimes(3);
    render([], [file("retry", "receiving")]);
    expect(notify).toHaveBeenCalledTimes(3);
    render([text("new-after-shrink", 4)], [file("retry", "complete", 5)]);
    expect(notify).toHaveBeenCalledTimes(5);
    expect(notify.mock.calls.slice(3).map(([item]) => item.id)).toEqual(["new-after-shrink", "retry"]);
    render([], [file("retry", "complete", 5)]);
    expect(notify).toHaveBeenCalledTimes(5);
  });
});
