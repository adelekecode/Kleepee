/**
 * Unit tests for CryptoManager (src/lib/crypto.ts)
 * Requirements: 5.1, 5.2, 5.3
 */
import { describe, it, expect } from "vitest";
import {
  generateSessionSecret,
  deriveKey,
  encrypt,
  decrypt,
} from "./crypto";

describe("generateSessionSecret", () => {
  it("returns a non-empty string", () => {
    expect(generateSessionSecret().length).toBeGreaterThan(0);
  });

  it("produces a base64url-encoded string (no +, /, or = characters)", () => {
    const secret = generateSessionSecret();
    expect(secret).not.toMatch(/[+/=]/);
  });

  it("generates a 32-byte secret (43 base64url chars without padding)", () => {
    // 32 bytes → 43 base64url chars (ceiling of 32*4/3, no padding)
    const secret = generateSessionSecret();
    expect(secret.length).toBe(43);
  });

  it("each call returns a different value", () => {
    const a = generateSessionSecret();
    const b = generateSessionSecret();
    expect(a).not.toBe(b);
  });
});

describe("deriveKey", () => {
  it("returns a CryptoKey with AES-GCM algorithm", async () => {
    const secret = generateSessionSecret();
    const key = await deriveKey(secret);
    expect(key).toBeInstanceOf(CryptoKey);
    expect(key.algorithm.name).toBe("AES-GCM");
  });

  it("same secret always derives the same key type", async () => {
    const secret = generateSessionSecret();
    const key1 = await deriveKey(secret);
    const key2 = await deriveKey(secret);
    // Both should be usable for encrypt/decrypt (same algorithmic parameters)
    expect(key1.algorithm).toEqual(key2.algorithm);
    expect(key1.type).toBe(key2.type);
  });
});

describe("encrypt / decrypt round trip", () => {
  it("decrypted output equals original plaintext", async () => {
    const secret = generateSessionSecret();
    const key = await deriveKey(secret);
    const plaintext = "Hello, Kleepee!";
    const cipherdata = await encrypt(key, plaintext);
    const recovered = await decrypt(key, cipherdata);
    expect(recovered).toBe(plaintext);
  });

  it("round trip works with Unicode content", async () => {
    const secret = generateSessionSecret();
    const key = await deriveKey(secret);
    const plaintext = "こんにちは 🌏";
    const cipherdata = await encrypt(key, plaintext);
    const recovered = await decrypt(key, cipherdata);
    expect(recovered).toBe(plaintext);
  });

  it("encrypt returns Uint8Array with at least IV_LENGTH (12) + 1 byte", async () => {
    const secret = generateSessionSecret();
    const key = await deriveKey(secret);
    const cipherdata = await encrypt(key, "x");
    expect(cipherdata).toBeInstanceOf(Uint8Array);
    // 12 IV + 1 plaintext + 16 GCM tag = 29 minimum
    expect(cipherdata.byteLength).toBeGreaterThan(12);
  });

  it("two encryptions of the same plaintext produce different ciphertexts (non-determinism)", async () => {
    const secret = generateSessionSecret();
    const key = await deriveKey(secret);
    const plaintext = "same text";
    const a = await encrypt(key, plaintext);
    const b = await encrypt(key, plaintext);
    // The IVs should differ, making the outputs unequal
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"));
  });
});
