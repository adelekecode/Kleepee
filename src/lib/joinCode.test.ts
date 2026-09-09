// @vitest-environment node
import { describe, expect, it } from "vitest";
import { generateJoinCode, normalizeJoinCode } from "./joinCode";

describe("short join codes", () => {
  it("generates exactly four unambiguous characters", () => {
    for (let i = 0; i < 100; i++) expect(generateJoinCode()).toMatch(/^[2-9A-HJ-NP-Z]{4}$/);
  });
  it("normalizes lowercase and spaces", () => {
    expect(normalizeJoinCode(" ab 2z ")).toBe("AB2Z");
  });
  it.each(["ABC", "ABCDE", "1O0I", "AB#2", ""])("rejects invalid code %s", (value) => {
    expect(() => normalizeJoinCode(value)).toThrow();
  });
});
