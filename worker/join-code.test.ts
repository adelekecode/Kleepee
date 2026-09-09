import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function createCode() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const token = "a".repeat(43);
  for (let attempt = 0; attempt < 20; attempt++) {
    const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    const code = [...crypto.getRandomValues(new Uint8Array(4))].map((n) => alphabet[n % alphabet.length]).join("");
    const url = `https://example.com/join-codes/${code}`;
    const response = await SELF.fetch(url, { method: "PUT", body: JSON.stringify({ publicKey, token }) });
    if (response.status === 409) continue;
    expect(response.status).toBe(201);
    return { url, publicKey, token };
  }
  throw new Error("Could not allocate test code");
}
const post = (url: string, body: unknown, token?: string) => SELF.fetch(url, {
  method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body),
});

describe("four-character join approval", () => {
  it("requires owner approval and never exposes owner credentials in public lookup", async () => {
    const { url, publicKey, token } = await createCode();
    const lookup = await SELF.fetch(url);
    const publicData = await lookup.json() as Record<string, unknown>;
    expect(publicData.publicKey).toEqual(publicKey);
    expect(publicData.token).toBeUndefined();
    expect(lookup.headers.get("Cache-Control")).toBe("no-store");
    const requestId = crypto.randomUUID();
    expect((await post(url, { action: "request", requestId, publicKey, deviceName: "Other phone" })).status).toBe(201);
    expect((await post(url, { action: "approve", requestId, payload: "A".repeat(64) })).status).toBe(403);
    expect(await (await post(url, { action: "status", requestId })).json()).toEqual({ status: "pending" });
    expect((await post(url, { action: "approve", requestId, payload: "A".repeat(64) }, token)).status).toBe(200);
    expect(await (await post(url, { action: "status", requestId })).json()).toEqual({ status: "approved", payload: "A".repeat(64) });
  });
  it("prevents overwrites, allows cancellation, and limits repeated requests", async () => {
    const { url, publicKey, token } = await createCode();
    expect((await SELF.fetch(url, { method: "PUT", body: JSON.stringify({ publicKey, token }) })).status).toBe(409);
    for (let i = 0; i < 3; i++) {
      const requestId = crypto.randomUUID();
      expect((await post(url, { action: "request", requestId, publicKey, deviceName: "Phone" })).status).toBe(201);
      expect((await post(url, { action: "cancel", requestId })).status).toBe(200);
    }
    expect((await post(url, { action: "request", requestId: crypto.randomUUID(), publicKey, deviceName: "Phone" })).status).toBe(429);
  });
});
