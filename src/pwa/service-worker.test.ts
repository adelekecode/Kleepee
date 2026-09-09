// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("./service-worker.js", import.meta.url), "utf8");
const origin = "https://kleepee.adelekecode.dev";
const cacheName = "kleepee-shell-current";
const precache = ["/index.html", "/assets/index-release.js", "/assets/index-release.css", "/manifest.webmanifest"];

function worker() {
  const handlers = new Map<string, (event: unknown) => void>();
  const contents = new Map<string, Response>();
  const cache = {
    addAll: vi.fn(async (_paths: string[]) => {}),
    match: vi.fn(async (path: string) => contents.get(path)),
    put: vi.fn(async () => {}),
  };
  const caches = {
    open: vi.fn(async (_name: string) => cache),
    keys: vi.fn(async () => [cacheName, "kleepee-shell-previous", "other-app-cache", "kleepee-unrelated"]),
    delete: vi.fn(async (_name: string) => true),
  };
  const fetch = vi.fn(async (_request: Request) => new Response("network response"));
  const skipWaiting = vi.fn();
  const claim = vi.fn();
  const reload = vi.fn();
  const self = {
    location: { origin, reload },
    clients: { claim, matchAll: vi.fn(async () => [{ navigate: reload }]) },
    skipWaiting,
    addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler),
  };
  runInNewContext(source, {
    self, caches, fetch, URL, Response,
    // Same release inputs injected by Vite; execute the actual worker source.
    __PRECACHE__: precache,
    __CACHE_NAME__: cacheName,
  });
  async function lifecycle(type: "install" | "activate") {
    const waitUntil = vi.fn();
    handlers.get(type)!({ waitUntil });
    await Promise.all(waitUntil.mock.calls.map(([pending]) => pending));
    return waitUntil;
  }
  function request(path: string, method = "GET", mode = "navigate") {
    const respondWith = vi.fn();
    const value = { url: new URL(path, origin).href, method, mode } as Request;
    handlers.get("fetch")!({ request: value, respondWith });
    return { value, respondWith, response: respondWith.mock.calls[0]?.[0] as Promise<Response> | undefined };
  }
  return { handlers, contents, cache, caches, fetch, skipWaiting, claim, reload, lifecycle, request, self };
}

describe("production service worker cache boundaries", () => {
  it("precaches only the explicit static shell list during install", async () => {
    const value = worker();
    const waited = await value.lifecycle("install");
    expect(waited).toHaveBeenCalledTimes(1);
    expect(value.caches.open).toHaveBeenCalledWith(cacheName);
    expect(value.cache.addAll).toHaveBeenCalledTimes(1);
    expect(value.cache.addAll).toHaveBeenCalledWith(precache);
    expect(value.cache.put).not.toHaveBeenCalled();
    expect(value.fetch).not.toHaveBeenCalled();
  });

  it("cleans only older Kleepee shell caches and preserves current and unrelated caches", async () => {
    const value = worker();
    await value.lifecycle("activate");
    expect(value.caches.delete).toHaveBeenCalledTimes(1);
    expect(value.caches.delete).toHaveBeenCalledWith("kleepee-shell-previous");
  });

  it.each(["/", "/waiting", "/connected", "/expired", "/j/ABC123", "/j/ABC123?source=qr#private-secret"])(
    "serves the static index for offline app navigation to %s without storing the requested URL",
    async (path) => {
      const value = worker();
      const shell = new Response("offline shell");
      value.contents.set("/index.html", shell);
      value.fetch.mockRejectedValue(new TypeError("Offline"));
      const request = value.request(path);
      expect(request.respondWith).toHaveBeenCalledTimes(1);
      expect(await request.response).toBe(shell);
      expect(value.fetch).toHaveBeenCalledWith(request.value);
      expect(value.cache.match).toHaveBeenCalledTimes(1);
      expect(value.cache.match).toHaveBeenCalledWith("/index.html");
      expect(value.cache.put).not.toHaveBeenCalled();
      expect(value.cache.addAll).not.toHaveBeenCalled();
    },
  );

  it("prefers the network for online app navigation and does not cache its response", async () => {
    const value = worker();
    const response = await value.request("/j/ABC123?source=link#secret").response;
    expect(await response!.text()).toBe("network response");
    expect(value.caches.open).not.toHaveBeenCalled();
    expect(value.cache.put).not.toHaveBeenCalled();
  });

  it("returns a network error when offline navigation has no installed shell", async () => {
    const value = worker();
    value.fetch.mockRejectedValue(new TypeError("Offline"));
    const response = await value.request("/connected").response;
    expect(response!.type).toBe("error");
  });

  it.each([
    ["/sessions", "POST", "cors"],
    ["/sessions", "GET", "navigate"],
    ["/sessions/ABC123", "GET", "cors"],
    ["/sessions/ABC123/ws", "GET", "cors"],
    ["https://kleepee-worker.adelekecode.dev/sessions", "POST", "cors"],
    ["https://kleepee-worker.adelekecode.dev/sessions/ABC123", "GET", "cors"],
    ["https://kleepee-worker.adelekecode.dev/connected", "GET", "navigate"],
    ["/assets/index-release.js?secret=value", "GET", "cors"],
    ["/unknown-file.bin", "GET", "cors"],
    ["/j/ABC123?source=qr#private-secret", "GET", "cors"],
  ])("does not intercept %s (%s, %s)", (path, method, mode) => {
    const value = worker();
    expect(value.request(path, method, mode).respondWith).not.toHaveBeenCalled();
    expect(value.caches.open).not.toHaveBeenCalled();
    expect(value.fetch).not.toHaveBeenCalled();
    expect(value.cache.put).not.toHaveBeenCalled();
  });

  it("serves explicitly precached assets and fetches misses without adding runtime cache entries", async () => {
    const value = worker();
    const script = new Response("cached script");
    value.contents.set("/assets/index-release.js", script);
    expect(await value.request("/assets/index-release.js", "GET", "cors").response).toBe(script);
    expect(value.fetch).not.toHaveBeenCalled();
    const missing = value.request("/assets/index-release.css", "GET", "cors");
    expect(await (await missing.response)!.text()).toBe("network response");
    expect(value.fetch).toHaveBeenCalledWith(missing.value);
    expect(value.cache.put).not.toHaveBeenCalled();
    expect(value.cache.addAll).not.toHaveBeenCalled();
  });

  it("does not activate updates early, claim clients, or reload running sessions", async () => {
    const value = worker();
    await value.lifecycle("install");
    await value.lifecycle("activate");
    await value.request("/connected").response;
    expect([...value.handlers.keys()]).toEqual(["install", "activate", "fetch"]);
    expect(value.skipWaiting).not.toHaveBeenCalled();
    expect(value.claim).not.toHaveBeenCalled();
    expect(value.self.clients.matchAll).not.toHaveBeenCalled();
    expect(value.reload).not.toHaveBeenCalled();
  });
});
