/**
 * Unit tests for content type classifier (src/lib/contentType.ts)
 * Requirements: 7.2, 7.3, 7.4
 */
import { describe, it, expect } from "vitest";
import { classifyContent } from "./contentType";

describe("classifyContent", () => {
  describe("URL detection", () => {
    it('returns "url" for an http URL', () => {
      expect(classifyContent("http://example.com")).toBe("url");
    });

    it('returns "url" for an https URL', () => {
      expect(classifyContent("https://example.com/path?q=1")).toBe("url");
    });

    it('returns "url" for a URL with a path and fragment', () => {
      expect(classifyContent("https://kleepee.app/j/abc123#secret")).toBe(
        "url",
      );
    });

    it('does NOT return "url" for ftp URLs (not http/https)', () => {
      expect(classifyContent("ftp://files.example.com")).not.toBe("url");
    });
  });

  describe("email detection", () => {
    it('returns "email" for a simple email address', () => {
      expect(classifyContent("user@example.com")).toBe("email");
    });

    it('returns "email" for an email with subdomains', () => {
      expect(classifyContent("user.name@mail.example.org")).toBe("email");
    });

    it('returns "email" for an email with plus-addressing', () => {
      expect(classifyContent("user+tag@example.com")).toBe("email");
    });
  });

  describe("plain text detection", () => {
    it('returns "text" for plain text', () => {
      expect(classifyContent("Hello, world!")).toBe("text");
    });

    it('returns "text" for a number string', () => {
      expect(classifyContent("12345")).toBe("text");
    });

    it('returns "text" for a string that looks like a partial URL', () => {
      expect(classifyContent("example.com")).toBe("text");
    });

    it('returns "text" for a multi-line string', () => {
      expect(classifyContent("line one\nline two")).toBe("text");
    });
  });
});
