import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIceServerLoader } from "./iceServers";

const servers = [
  {
    urls: "turns:turn.cloudflare.com:443?transport=tcp",
    username: "temporary-user",
    credential: "temporary-password",
  },
];

describe("session ICE credentials", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("caches credentials across retries and refreshes before expiry", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ iceServers: servers, expiresAt: Date.now() + 3_600_000 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const load = createIceServerLoader(
      "https://worker.test",
      "ABC123",
      "device-1",
    );
    expect(await load()).toEqual(servers);
    expect(await load()).toEqual(servers);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]).toEqual([
      "https://worker.test/sessions/ABC123/ice-servers?deviceId=device-1",
      { cache: "no-store", signal: expect.any(AbortSignal) },
    ]);
    vi.setSystemTime(Date.now() + 3_580_000);
    await load();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares an in-flight credential request", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ iceServers: servers, expiresAt: Date.now() + 60_000 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const load = createIceServerLoader(
      "https://worker.test",
      "ABC123",
      "device-1",
    );
    const first = load();
    expect(load()).toBe(first);
    await first;
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retains direct connections while an older Worker is deployed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404 })),
    );
    const load = createIceServerLoader(
      "https://worker.test",
      "ABC123",
      "device-1",
    );
    expect(await load()).toEqual(
      expect.arrayContaining([{ urls: "stun:stun.l.google.com:19302" }]),
    );
  });

  it("retries a failed credential request instead of caching it or silently dropping TURN", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ iceServers: servers, expiresAt: Date.now() + 60_000 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const load = createIceServerLoader(
      "https://worker.test",
      "ABC123",
      "device-1",
    );
    await expect(load()).rejects.toThrow("unavailable");
    expect(await load()).toEqual(servers);
  });

  it.each([
    { iceServers: servers, expiresAt: 0 },
    { iceServers: [], expiresAt: Number.MAX_SAFE_INTEGER },
    {
      iceServers: [{ urls: "turn:turn.cloudflare.com:3478" }],
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
    {
      iceServers: [{ urls: "https://unexpected.test" }],
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
  ])("rejects invalid or expired relay settings: %j", async (config) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(config)),
    );
    await expect(
      createIceServerLoader("https://worker.test", "ABC123", "device-1")(),
    ).rejects.toThrow("Invalid");
  });
});
