/**
 * Unit tests for QRManager / URL helpers (src/lib/qr.ts)
 * Requirements: 2.4, 2.5, 3.1, 5.4
 */
import { describe, it, expect } from "vitest";
import { buildJoinURL, parseJoinURL } from "./qr";

describe("buildJoinURL", () => {
  it("returns a string starting with https://kleepee.adelekecode.dev/j/", () => {
    const url = buildJoinURL("abc123", "mysecret");
    expect(url.startsWith("https://kleepee.adelekecode.dev/j/")).toBe(true);
  });

  it("places the sessionId in the path", () => {
    const url = buildJoinURL("SESSION_ID", "SECRET");
    expect(url).toContain("/j/SESSION_ID");
  });

  it("places the sessionSecret in the fragment only (Req 2.4, 5.4)", () => {
    const secret = "myBase64UrlSecret";
    const url = buildJoinURL("abc", secret);
    const parsed = new URL(url);
    expect(parsed.hash).toBe(`#${secret}`);
    expect(parsed.pathname).not.toContain(secret);
    expect(parsed.search).not.toContain(secret);
  });

  it("sessionSecret does not appear in pathname or query string", () => {
    const secret = "secretValue123";
    const url = buildJoinURL("id42", secret);
    const parsed = new URL(url);
    expect(parsed.pathname).not.toContain(secret);
    expect(parsed.search).not.toContain(secret);
  });
});

describe("parseJoinURL", () => {
  it("extracts the sessionId from the path", () => {
    const { sessionId } = parseJoinURL("https://kleepee.adelekecode.dev/j/SESSION123#SECRET");
    expect(sessionId).toBe("SESSION123");
  });

  it("extracts the sessionSecret from the fragment", () => {
    const { sessionSecret } = parseJoinURL("https://kleepee.app/j/abc#mySecret");
    expect(sessionSecret).toBe("mySecret");
  });

  it("round trip: buildJoinURL → parseJoinURL recovers original values (Req 3.1)", () => {
    const sessionId = "abc123";
    const sessionSecret = "base64url_secret";
    const url = buildJoinURL(sessionId, sessionSecret);
    const recovered = parseJoinURL(url);
    expect(recovered.sessionId).toBe(sessionId);
    expect(recovered.sessionSecret).toBe(sessionSecret);
  });

  it("round trip with special characters in sessionSecret", () => {
    const sessionId = "xyz789";
    const sessionSecret = "aB3_-xYz42_abcDEF";
    const url = buildJoinURL(sessionId, sessionSecret);
    const recovered = parseJoinURL(url);
    expect(recovered.sessionId).toBe(sessionId);
    expect(recovered.sessionSecret).toBe(sessionSecret);
  });
});
