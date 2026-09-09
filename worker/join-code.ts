const KEY = "joinCode";
const TTL = 10 * 60_000;
interface JoinRequest { requestId: string; publicKey: JsonWebKey; deviceName: string; expiresAt: number; status: "pending" | "approved" | "denied"; payload?: string }
interface CodeRecord { token: string; publicKey: JsonWebKey; expiresAt: number; request: JoinRequest | null; attempts: number[] }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});
function validKey(key: unknown): key is JsonWebKey {
  if (!key || typeof key !== "object") return false;
  const value = key as JsonWebKey;
  return value.kty === "EC" && value.crv === "P-256" && typeof value.x === "string" && typeof value.y === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.x) && /^[A-Za-z0-9_-]{43}$/.test(value.y) && !value.d;
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error();
  let raw = "", size = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) { await reader.cancel(); throw new Error(); }
      raw += decoder.decode(value, { stream: true });
    }
    const body = JSON.parse(raw + decoder.decode());
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } finally { reader.releaseLock(); }
}
/** These namespaced objects never receive a plaintext session secret. */
export async function handleJoinCode(request: Request, ctx: DurableObjectState): Promise<Response> {
  let body: Record<string, unknown> = {};
  if (request.method !== "GET") {
    try { body = await readBody(request); } catch { return json({ error: "Invalid or oversized request" }, 400); }
  }
  return ctx.blockConcurrencyWhile(async () => {
    const now = Date.now();
    const record = await ctx.storage.get<CodeRecord>(KEY);
    if (request.method === "PUT") {
      if (record && record.expiresAt > now) return json({ error: "Code already exists" }, 409);
      if (!validKey(body.publicKey) || typeof body.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) return json({ error: "Invalid code" }, 400);
      const expiresAt = now + TTL;
      await ctx.storage.put({ joinCodeObject: true, [KEY]: { token: body.token, publicKey: body.publicKey, expiresAt, request: null, attempts: [] } });
      await ctx.storage.setAlarm(expiresAt);
      return json({ expiresAt }, 201);
    }
    if (!record) return json({ error: "Code not found" }, 404);
    if (record.expiresAt <= now) return json({ error: "Code expired" }, 410);
    const owner = request.headers.get("Authorization") === `Bearer ${record.token}`;
    if (request.method === "GET") return json(owner
      ? { request: record.request && record.request.expiresAt > now ? record.request : null }
      : { publicKey: record.publicKey, expiresAt: record.expiresAt });
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (body.action === "request") {
      if (!validKey(body.publicKey) || typeof body.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(body.requestId) ||
        typeof body.deviceName !== "string" || !body.deviceName.trim() || body.deviceName.length > 80) return json({ error: "Invalid request" }, 400);
      if (record.request && record.request.expiresAt > now && record.request.status !== "denied") return json({ error: "Request already pending" }, 409);
      record.attempts = record.attempts.filter((time) => time > now - 60_000);
      if (record.attempts.length >= 3) return json({ error: "Too many requests" }, 429);
      record.attempts.push(now);
      record.request = { requestId: body.requestId, publicKey: body.publicKey, deviceName: body.deviceName, expiresAt: Math.min(now + 120_000, record.expiresAt), status: "pending" };
      await ctx.storage.put(KEY, record);
      return json({ ok: true }, 201);
    }
    const incoming = record.request;
    if (!incoming || incoming.requestId !== body.requestId || incoming.expiresAt <= now) return json({ error: "Request expired" }, 404);
    if (body.action === "cancel") {
      incoming.status = "denied";
      delete incoming.payload;
      await ctx.storage.put(KEY, record);
      return json({ ok: true });
    }
    if (body.action === "status") return json({ status: incoming.status, payload: incoming.payload });
    if (!owner) return json({ error: "Approval requires the sender" }, 403);
    if (incoming.status !== "pending") return json({ error: "Request already answered" }, 409);
    if (body.action === "approve") {
      if (typeof body.payload !== "string" || body.payload.length < 40 || body.payload.length > 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.payload)) return json({ error: "Invalid envelope" }, 400);
      incoming.payload = body.payload;
      incoming.status = "approved";
    } else if (body.action === "deny") incoming.status = "denied";
    else return json({ error: "Invalid action" }, 400);
    await ctx.storage.put(KEY, record);
    return json({ ok: true });
  });
}
export async function expireJoinCode(ctx: DurableObjectState): Promise<boolean> {
  if (!(await ctx.storage.get<boolean>("joinCodeObject"))) return false;
  const record = await ctx.storage.get<CodeRecord>(KEY);
  if (record && record.expiresAt > Date.now()) await ctx.storage.setAlarm(record.expiresAt);
  else await ctx.storage.delete(KEY);
  return true;
}
