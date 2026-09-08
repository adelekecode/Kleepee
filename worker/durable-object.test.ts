/// <reference types="@cloudflare/vitest-pool-workers" />
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

interface TestPeer {
  ws: WebSocket;
  messages: string[];
  next: () => Promise<string>;
  closed: Promise<CloseEvent>;
}

const peers: TestPeer[] = [];
const sessions: string[] = [];

declare module "cloudflare:test" {
  interface ProvidedEnv {
    SESSION_DO: DurableObjectNamespace;
  }
}

async function createSession(): Promise<string> {
  const response = await SELF.fetch("https://worker.test/sessions", { method: "POST" });
  const body = await response.json() as { sessionId: string };
  sessions.push(body.sessionId);
  return body.sessionId;
}

async function connect(sessionId: string, deviceId: string): Promise<TestPeer> {
  const response = await SELF.fetch(
    `https://worker.test/sessions/${sessionId}/ws?deviceId=${deviceId}&deviceName=${deviceId}`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const messages: string[] = [];
  const waiting: Array<(message: string) => void> = [];
  ws.addEventListener("message", (event) => {
    const message = String(event.data);
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else messages.push(message);
  });
  const closed = new Promise<CloseEvent>((resolve) => {
    ws.addEventListener("close", (event) => {
      if (ws.readyState === WebSocket.CLOSING) ws.close();
      resolve(event);
    }, { once: true });
  });
  ws.accept();
  const peer = {
    ws,
    messages,
    closed,
    next: () => messages.length
      ? Promise.resolve(messages.shift()!)
      : new Promise<string>((resolve) => waiting.push(resolve)),
  };
  peers.push(peer);
  return peer;
}

async function state(sessionId: string): Promise<{ deviceCount: number }> {
  return (await SELF.fetch(`https://worker.test/sessions/${sessionId}`)).json();
}

afterEach(async () => {
  await Promise.all(peers.splice(0).map(async ({ ws, closed }) => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1000);
    await closed;
  }));
  for (const sessionId of sessions.splice(0)) {
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
    await runInDurableObject(stub, async (_instance, ctx) => {
      await ctx.storage.sync();
    });
  }
});

describe("Durable Object peer connections", () => {
  it("relays all signaling messages only to the other peer", async () => {
    const id = await createSession();
    const first = await connect(id, "first");
    const second = await connect(id, "second");
    expect(JSON.parse(await first.next())).toEqual({ type: "peer.join", deviceName: "second" });
    expect(JSON.parse(await second.next())).toEqual({ type: "peer.join", deviceName: "first" });

    for (const message of [
      { type: "signal.offer", offer: { type: "offer", sdp: "offer-sdp" } },
      { type: "signal.answer", answer: { type: "answer", sdp: "answer-sdp" } },
      { type: "signal.ice", candidate: { candidate: "candidate-value" } },
    ]) {
      const wire = JSON.stringify(message);
      first.ws.send(wire);
      expect(await second.next()).toBe(wire);
      second.ws.send(wire);
      expect(await first.next()).toBe(wire);
    }
    expect(first.messages).toEqual([]);
    expect(second.messages).toEqual([]);
  });

  it("replaces the same device without phantom peers or a peer.leave event", async () => {
    const id = await createSession();
    const first = await connect(id, "first");
    const oldSecond = await connect(id, "second");
    await first.next();
    await oldSecond.next();

    const replacement = await connect(id, "second");
    expect((await oldSecond.closed).code).toBe(4401);
    expect(JSON.parse(await first.next())).toEqual({ type: "peer.join", deviceName: "second" });
    expect(JSON.parse(await replacement.next())).toEqual({ type: "peer.join", deviceName: "first" });
    expect(await state(id)).toMatchObject({ deviceCount: 2 });
    const reconnectState = await SELF.fetch(`https://worker.test/sessions/${id}?deviceId=second`);
    expect(await reconnectState.json()).toMatchObject({ deviceCount: 2, canJoin: true });
    const thirdState = await SELF.fetch(`https://worker.test/sessions/${id}?deviceId=third`);
    expect(await thirdState.json()).toMatchObject({ deviceCount: 2, canJoin: false });

    const signal = JSON.stringify({ type: "signal.offer", offer: { type: "offer", sdp: "replacement" } });
    first.ws.send(signal);
    expect(await replacement.next()).toBe(signal);
    replacement.ws.send(signal);
    expect(await first.next()).toBe(signal);

    const third = await SELF.fetch(`https://worker.test/sessions/${id}/ws?deviceId=third`, {
      headers: { Upgrade: "websocket" },
    });
    expect(third.status).toBe(409);
    expect(await state(id)).toMatchObject({ deviceCount: 2 });
    expect(first.messages).toEqual([]);
  });

  it("frees a disconnected device slot and relays to its replacement", async () => {
    const id = await createSession();
    const first = await connect(id, "first");
    const second = await connect(id, "second");
    await first.next();
    await second.next();
    second.ws.close(1000);
    await second.closed;
    expect(JSON.parse(await first.next())).toEqual({ type: "peer.leave" });
    expect(await state(id)).toMatchObject({ deviceCount: 1 });

    const third = await connect(id, "third");
    expect(JSON.parse(await first.next())).toEqual({ type: "peer.join", deviceName: "third" });
    await third.next();
    const signal = JSON.stringify({ type: "signal.ice", candidate: { candidate: "new-peer" } });
    first.ws.send(signal);
    expect(await third.next()).toBe(signal);
  });
});
