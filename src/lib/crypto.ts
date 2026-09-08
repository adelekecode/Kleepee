/**
 * CryptoManager — browser Web Crypto helpers for Kleepee V1
 *
 * generateSessionSecret — generates a 32-byte base64url secret
 * deriveKey             — HKDF(SHA-256) → AES-GCM 256-bit CryptoKey
 * encrypt               — AES-GCM encrypt: returns IV || ciphertext
 * decrypt               — AES-GCM decrypt: splits IV, returns UTF-8 string
 */

const IV_LENGTH = 12; // bytes — standard AES-GCM nonce length

/**
 * Generates a cryptographically random 32-byte session secret encoded as
 * base64url (no padding).
 *
 * Requirements: 5.1
 */
export function generateSessionSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // Convert to base64 then make URL-safe
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Derives an AES-GCM 256-bit CryptoKey from a base64url-encoded session secret
 * using HKDF with SHA-256.
 *
 * salt = UTF-8("kleepee-v1")
 * info = UTF-8("aes-gcm-key")
 *
 * Requirements: 5.1, 5.3
 */
export async function deriveKey(sessionSecret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();

  // Import the raw secret bytes as HKDF key material
  const rawBytes = Uint8Array.from(atob(sessionSecret.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0)
  );

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    rawBytes,
    { name: "HKDF" },
    false,
    ["deriveKey"]
  );

  // Derive the AES-GCM key via HKDF
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("kleepee-v1"),
      info: encoder.encode("aes-gcm-key"),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypts `plaintext` with AES-GCM using a random 12-byte IV.
 * Returns a Uint8Array containing: [ IV (12 bytes) | ciphertext ]
 *
 * Requirements: 5.2, 5.3
 */
export async function encrypt(key: CryptoKey, plaintext: string): Promise<Uint8Array> {
  const iv = new Uint8Array(IV_LENGTH);
  crypto.getRandomValues(iv);

  const encodedPlaintext = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encodedPlaintext
  );

  // Concatenate IV and ciphertext into a single Uint8Array
  const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), IV_LENGTH);
  return result;
}

/**
 * Decrypts data produced by `encrypt`. Splits the first 12 bytes as the IV,
 * decrypts the remainder with AES-GCM, and returns the UTF-8 plaintext.
 *
 * Requirements: 5.2, 5.3
 */
export async function decrypt(key: CryptoKey, data: Uint8Array): Promise<string> {
  const iv = data.slice(0, IV_LENGTH);
  const ciphertext = data.slice(IV_LENGTH);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintext);
}
