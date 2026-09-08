/**
 * Unit tests for shared TypeScript types (src/types/index.ts)
 * Requirements: 12.1, 12.2, 12.4
 */
import { describe, it, expect } from "vitest";
import type { TextItem, DeviceIdentity, SessionContext, SessionState } from "./index";

describe("TextItem serialization round trip (Req 12.1, 12.2, 12.4)", () => {
  it("serializes and deserializes a TextItem without data loss", () => {
    const item: TextItem = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      type: "text",
      senderId: "device-001",
      senderName: "Bright Panda",
      timestamp: 1700000000000,
      content: "Hello from Device A",
    };

    const serialized = JSON.stringify(item);
    const deserialized: TextItem = JSON.parse(serialized);

    expect(deserialized).toEqual(item);
  });

  it('type field is always "text"', () => {
    const item: TextItem = {
      id: "123",
      type: "text",
      senderId: "s1",
      senderName: "Swift Fox",
      timestamp: 0,
      content: "test",
    };
    const recovered: TextItem = JSON.parse(JSON.stringify(item));
    expect(recovered.type).toBe("text");
  });

  it("preserves all required fields after serialization", () => {
    const item: TextItem = {
      id: "abc",
      type: "text",
      senderId: "dev-1",
      senderName: "Wild Bear",
      timestamp: 42,
      content: "some content",
    };
    const recovered: TextItem = JSON.parse(JSON.stringify(item));
    expect(recovered.id).toBe(item.id);
    expect(recovered.senderId).toBe(item.senderId);
    expect(recovered.senderName).toBe(item.senderName);
    expect(recovered.timestamp).toBe(item.timestamp);
    expect(recovered.content).toBe(item.content);
  });

  it("handles Unicode content correctly", () => {
    const item: TextItem = {
      id: "unicode-test",
      type: "text",
      senderId: "dev-2",
      senderName: "Jolly Otter",
      timestamp: 9999,
      content: "日本語テスト 🎌",
    };
    const recovered: TextItem = JSON.parse(JSON.stringify(item));
    expect(recovered.content).toBe(item.content);
  });
});

describe("SessionState type values", () => {
  it("all expected session states are valid string literals", () => {
    const states: SessionState[] = [
      "WAITING",
      "CONNECTING",
      "CONNECTED",
      "DISCONNECTED",
      "EXPIRED",
    ];
    expect(states).toHaveLength(5);
    states.forEach((s) => expect(typeof s).toBe("string"));
  });
});
