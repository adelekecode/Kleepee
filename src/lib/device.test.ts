/**
 * Unit tests for DeviceManager (src/lib/device.ts)
 * Requirements: 1.1, 1.2, 1.3
 */
import { describe, it, expect, beforeEach } from "vitest";
import { generateDeviceName, loadOrCreateIdentity } from "./device";

describe("generateDeviceName", () => {
  it("returns a string with exactly two words", () => {
    const name = generateDeviceName();
    const words = name.trim().split(" ");
    expect(words).toHaveLength(2);
  });

  it("both words start with an uppercase letter", () => {
    const name = generateDeviceName();
    const [adj, animal] = name.split(" ");
    expect(adj[0]).toBe(adj[0].toUpperCase());
    expect(animal[0]).toBe(animal[0].toUpperCase());
  });

  it("returns a non-empty string", () => {
    expect(generateDeviceName().length).toBeGreaterThan(0);
  });
});

describe("loadOrCreateIdentity", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("creates a new identity when localStorage is empty", () => {
    const identity = loadOrCreateIdentity();
    expect(identity.deviceId).toBeTruthy();
    expect(identity.deviceName).toBeTruthy();
  });

  it("persists deviceId to localStorage on first call", () => {
    loadOrCreateIdentity();
    expect(localStorage.getItem("kleepee.device.id")).toBeTruthy();
  });

  it("persists deviceName to localStorage on first call", () => {
    loadOrCreateIdentity();
    expect(localStorage.getItem("kleepee.device.name")).toBeTruthy();
  });

  it("returns the same identity on subsequent calls (Req 1.3)", () => {
    const first = loadOrCreateIdentity();
    const second = loadOrCreateIdentity();
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.deviceName).toBe(first.deviceName);
  });

  it("loads existing values from localStorage without overwriting them", () => {
    localStorage.setItem("kleepee.device.id", "test-id-123");
    localStorage.setItem("kleepee.device.name", "Test Name");
    const identity = loadOrCreateIdentity();
    expect(identity.deviceId).toBe("test-id-123");
    expect(identity.deviceName).toBe("Test Name");
  });

  it("deviceId looks like a UUID (Req 1.1)", () => {
    const { deviceId } = loadOrCreateIdentity();
    expect(deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it("deviceName has two words (Req 1.2)", () => {
    const { deviceName } = loadOrCreateIdentity();
    expect(deviceName.trim().split(" ")).toHaveLength(2);
  });
});
