/// <reference types="@cloudflare/vitest-pool-workers" />
import { env, fetchMock, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "./index";
import { getIceServerConfiguration, type TurnEnv } from "./ice-servers";

const testSecrets = { TURN_KEY_ID: "test-turn-key", TURN_KEY_API_TOKEN: "server-only-test-token" };
const providerOrigin = "https://rtc.live.cloudflare.com";
const providerPath = "/v1/turn/keys/test-turn-key/credentials/generate-ice-servers";
const providerConfiguration = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"], extra: "discard" },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turn:turn.cloudflare.com:80?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
        "https://untrusted.example/",
      ],
      username: "temporary-user",
      credential: "temporary-password",
      extra: "discard",
    },
  ],
  token: "discard",
};
const sessions: string[] = [];
const peers: Array<{ ws: WebSocket; closed: Promise<void> }> = [];

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(async () => {
  fetchMock.assertNoPendingInterceptors();
  fetchMock.deactivate();
  await Promise.all(peers.splice(0).map(async ({ ws, closed }) => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1000);
    await closed;
  }));
  for (const id of sessions.splice(0)) {
    await runInDurableObject(env.SESSION_DO.get(env.SESSION_DO.idFromName(id)), async (_instance, ctx) => {
      await ctx.storage.sync();
    });
  }
});

function mockProvider(body: object, status = 201) {
  fetchMock.get(providerOrigin).intercept({
    path: providerPath,
    method: "POST",
    headers: { authorization: `Bearer ${testSecrets.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl: 3600 }),
  }).reply(status, body);
}

async function createSession(): Promise<string> {
  const response = await SELF.fetch("https://worker.test/sessions", { method: "POST" });
  const { sessionId } = await response.json() as { sessionId: string };
  sessions.push(sessionId);
  return sessionId;
}

async function connect(id: string, deviceId: string) {
  const response = await SELF.fetch(`https://worker.test/sessions/${id}/ws?deviceId=${deviceId}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => {
    if (ws.readyState === WebSocket.CLOSING) ws.close();
    resolve();
  }, { once: true }));
  ws.accept();
  peers.push({ ws, closed });
}

function requestIce(id: string, deviceId = "first", secrets: TurnEnv = {}, prefix = "") {
  return worker.fetch(new Request(`https://worker.test${prefix}/sessions/${id}/ice-servers?deviceId=${deviceId}`), {
    ...env,
    ...secrets,
  });
}

describe("TURN credential configuration", () => {
  it("returns short-lived STUN-only configuration when TURN is not configured", async () => {
    const before = Date.now();
    const result = await getIceServerConfiguration({});
    expect(result.relayAvailable).toBe(false);
    expect(result.iceServers).toEqual([
      { urls: ["stun:stun.l.google.com:19302"] },
      { urls: ["stun:stun1.l.google.com:19302"] },
    ]);
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it.each([{ TURN_KEY_ID: "key" }, { TURN_KEY_API_TOKEN: "token" }])(
    "rejects partial configuration without making a provider request",
    async (secrets) => {
      await expect(getIceServerConfiguration(secrets)).rejects.toThrow("Relay unavailable");
    },
  );

  it("mints one-hour credentials and retains UDP, TCP, TLS while filtering port 53 and metadata", async () => {
    mockProvider(providerConfiguration);
    const before = Date.now();
    const result = await getIceServerConfiguration(testSecrets);
    expect(result.relayAvailable).toBe(true);
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(result.iceServers).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turn:turn.cloudflare.com:3478?transport=tcp",
          "turn:turn.cloudflare.com:80?transport=tcp",
          "turns:turn.cloudflare.com:5349?transport=tcp",
          "turns:turn.cloudflare.com:443?transport=tcp",
        ],
        username: "temporary-user",
        credential: "temporary-password",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(testSecrets.TURN_KEY_API_TOKEN);
    expect(JSON.stringify(result)).not.toContain(testSecrets.TURN_KEY_ID);
  });

  it("accepts a single URL string in a provider ICE entry", async () => {
    mockProvider({ iceServers: [{ urls: "turns:turn.cloudflare.com:443?transport=tcp", username: "u", credential: "p" }] });
    expect((await getIceServerConfiguration(testSecrets)).relayAvailable).toBe(true);
  });

  it.each([
    {},
    { iceServers: [] },
    { iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }] },
    { iceServers: [{ urls: ["turn:turn.cloudflare.com:53?transport=udp"], username: "u", credential: "p" }] },
    { iceServers: [{ urls: ["turns:turn.cloudflare.com:443?transport=tcp"], username: "u" }] },
    { iceServers: [{ urls: ["turns:turn.cloudflare.com:443?transport=tcp"], username: "", credential: "p" }] },
  ])("rejects invalid or unusable provider configuration", async (body) => {
    mockProvider(body);
    await expect(getIceServerConfiguration(testSecrets)).rejects.toThrow("Relay unavailable");
  });

  it("sanitizes provider HTTP failures", async () => {
    mockProvider({ error: testSecrets.TURN_KEY_API_TOKEN }, 401);
    await expect(getIceServerConfiguration(testSecrets)).rejects.toThrow(/^Relay unavailable$/);
  });

  it("sanitizes provider network failures", async () => {
    fetchMock.get(providerOrigin).intercept({ path: providerPath, method: "POST" })
      .replyWithError(new Error(testSecrets.TURN_KEY_API_TOKEN));
    await expect(getIceServerConfiguration(testSecrets)).rejects.toThrow(/^Relay unavailable$/);
  });
});

describe("session ICE endpoint", () => {
  it("returns no-store credentials for an active session, including the /api prefix", async () => {
    const id = await createSession();
    await connect(id, "first");
    mockProvider(providerConfiguration);
    const response = await requestIce(id, "first", testSecrets, "/api");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.json()).toMatchObject({ relayAvailable: true });
  });

  it("allows an existing device to fetch credentials while a session has two peers", async () => {
    const id = await createSession();
    await connect(id, "first");
    await connect(id, "second");
    const response = await requestIce(id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ relayAvailable: false });
  });

  it("rejects a third device before requesting provider credentials", async () => {
    const id = await createSession();
    await connect(id, "first");
    await connect(id, "second");
    const response = await requestIce(id, "third", testSecrets);
    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects an empty or nonexistent session before requesting credentials", async () => {
    const id = await createSession();
    expect((await requestIce(id, "first", testSecrets)).status).toBe(404);
    expect((await requestIce(crypto.randomUUID().replaceAll("-", ""), "first", testSecrets)).status).toBe(404);
  });

  it("rejects an expired session before requesting credentials", async () => {
    const id = await createSession();
    await runInDurableObject(env.SESSION_DO.get(env.SESSION_DO.idFromName(id)), async (_instance, ctx) => {
      await ctx.storage.put("sessionState", "EXPIRED");
    });
    expect((await requestIce(id, "first", testSecrets)).status).toBe(410);
  });

  it("requires a device identity", async () => {
    const id = await createSession();
    expect((await requestIce(id, "", testSecrets)).status).toBe(400);
  });

  it("returns a sanitized 503 when configured relay provisioning fails", async () => {
    const id = await createSession();
    await connect(id, "first");
    mockProvider({ error: testSecrets.TURN_KEY_API_TOKEN }, 500);
    const response = await requestIce(id, "first", testSecrets);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Connection relay unavailable" });
  });

  it("returns a sanitized 503 for partial server configuration", async () => {
    const id = await createSession();
    await connect(id, "first");
    const response = await requestIce(id, "first", { TURN_KEY_ID: "key" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Connection relay unavailable" });
  });
});
