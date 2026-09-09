import { decrypt, encrypt, generateSessionSecret } from "./crypto";
import { sessionRequest } from "./sessionRequest";

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const WORKER = import.meta.env.VITE_WORKER_URL || "https://kleepee-worker.adelekecode.dev";
export const JOIN_CODE_LIFETIME = 10 * 60_000;
type Keys = CryptoKeyPair;
export interface JoinCodeOwner { code: string; token: string; keys: Keys; expiresAt: number }
export interface JoinRequest { requestId: string; publicKey: JsonWebKey; deviceName: string; expiresAt: number; status: "pending" | "approved" | "denied"; payload?: string }

export function normalizeJoinCode(value: string): string {
  const code = value.toUpperCase().replace(/\s/g, "");
  if (code.length !== 4 || [...code].some((character) => !ALPHABET.includes(character))) {
    throw new Error("Enter the 4-character code or paste the full join link.");
  }
  return code;
}
export function generateJoinCode(): string {
  let code = "";
  while (code.length < 4) {
    for (const byte of crypto.getRandomValues(new Uint8Array(8))) {
      if (byte < Math.floor(256 / ALPHABET.length) * ALPHABET.length) code += ALPHABET[byte % ALPHABET.length];
      if (code.length === 4) break;
    }
  }
  return code;
}
const generateKeys = () => crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);

async function exchange(keys: Keys, publicKey: JsonWebKey, code: string, requestId: string) {
  const peer = await crypto.subtle.importKey("jwk", publicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, keys.privateKey, 256);
  const context = new TextEncoder().encode(`kleepee-code-v1:${code}:${requestId}`);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: context, info: new TextEncoder().encode("pairing") }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const proof = new Uint8Array(32 + context.length);
  proof.set(new Uint8Array(shared)); proof.set(context, 32);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", proof));
  const verification = ((digest[0] * 65536 + digest[1] * 256 + digest[2]) % 1_000_000).toString().padStart(6, "0");
  return { key, verification };
}

async function request(code: string, signal: AbortSignal, init: RequestInit = {}) {
  const result = await sessionRequest(`${WORKER}/join-codes/${code}`, init, signal);
  if (result.response.status === 404 || result.response.status === 410) throw new Error("Code not found or expired. Ask for a new code.");
  return result;
}
const json = (body: unknown, token?: string): RequestInit => ({
  method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
});

export async function publishJoinCode(signal: AbortSignal): Promise<JoinCodeOwner> {
  const keys = await generateKeys();
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const token = generateSessionSecret();
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateJoinCode();
    const { response, body } = await request(code, signal, { ...json({ publicKey, token }), method: "PUT" });
    if (response.status === 409) continue;
    if (!response.ok) throw new Error("Could not create a code. Use the QR/link or try again.");
    return { code, token, keys, expiresAt: (body as { expiresAt: number }).expiresAt };
  }
  throw new Error("Could not create a code. Please try again.");
}

export async function pollJoinRequest(owner: JoinCodeOwner, signal: AbortSignal): Promise<JoinRequest | null> {
  const { response, body } = await request(owner.code, signal, { headers: { Authorization: `Bearer ${owner.token}` } });
  if (!response.ok) throw new Error("Could not check join requests.");
  return (body as { request: JoinRequest | null }).request;
}
export async function inspectJoinRequest(owner: JoinCodeOwner, incoming: JoinRequest) {
  return exchange(owner.keys, incoming.publicKey, owner.code, incoming.requestId);
}
export async function answerJoinRequest(owner: JoinCodeOwner, incoming: JoinRequest, sessionId: string, sessionSecret: string, approve: boolean, signal: AbortSignal) {
  let payload: string | undefined;
  if (approve) {
    const { key } = await inspectJoinRequest(owner, incoming);
    const bytes = await encrypt(key, JSON.stringify({ sessionId, sessionSecret, expiresAt: incoming.expiresAt }));
    payload = btoa(String.fromCharCode(...bytes));
  }
  const { response } = await request(owner.code, signal, json({ action: approve ? "approve" : "deny", requestId: incoming.requestId, payload }, owner.token));
  if (!response.ok) throw new Error("This request expired or changed. Ask the other device to try again.");
}

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("Cancelled", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 2000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
export async function resolveJoinCode(value: string, deviceName: string, signal: AbortSignal, onVerification: (value: string) => void) {
  const code = normalizeJoinCode(value);
  const { response, body } = await request(code, signal);
  if (!response.ok) throw new Error("Could not look up this code.");
  const keys = await generateKeys();
  const requestId = crypto.randomUUID();
  const { key, verification } = await exchange(keys, (body as { publicKey: JsonWebKey }).publicKey, code, requestId);
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const submitted = await request(code, signal, json({ action: "request", requestId, publicKey, deviceName }));
  if (submitted.response.status === 409) throw new Error("Another device is requesting to join. Try again shortly.");
  if (submitted.response.status === 429) throw new Error("Too many join requests. Wait a minute and try again.");
  if (!submitted.response.ok) throw new Error("Could not request access. Try again.");
  const cancel = () => {
    void fetch(`${WORKER}/join-codes/${code}`, { ...json({ action: "cancel", requestId }), keepalive: true }).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) { cancel(); throw new DOMException("Cancelled", "AbortError"); }
  try {
  onVerification(verification);
  const deadline = Date.now() + 2 * 60_000;
  while (Date.now() < deadline) {
    await pause(signal);
    const polled = await request(code, signal, json({ action: "status", requestId }));
    if (!polled.response.ok) throw new Error("This join request expired. Try again.");
    const status = polled.body as { status: string; payload?: string };
    if (status.status === "denied") throw new Error("The sender declined this request.");
    if (status.status !== "approved") continue;
    let details: { sessionId?: unknown; sessionSecret?: unknown; expiresAt?: unknown };
    try {
      if (typeof status.payload !== "string" || status.payload.length > 1024) throw new Error();
      details = JSON.parse(await decrypt(key, Uint8Array.from(atob(status.payload), (character) => character.charCodeAt(0))));
    } catch { throw new Error("Could not verify this approval. Ask for a new code."); }
    if (!details || typeof details.sessionId !== "string" || !/^[A-Za-z0-9]+$/.test(details.sessionId) ||
      typeof details.sessionSecret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(details.sessionSecret) ||
      typeof details.expiresAt !== "number" || !Number.isFinite(details.expiresAt) || details.expiresAt <= Date.now()) {
      throw new Error("This approval is invalid or expired. Try again.");
    }
    return { sessionId: details.sessionId, sessionSecret: details.sessionSecret };
  }
  throw new Error("The sender did not respond. Try again with both devices open.");
  } finally { signal.removeEventListener("abort", cancel); }
}
