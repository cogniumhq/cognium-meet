import { describe, expect, it } from "vitest";
import { formatTimestamp, segmentsToPlainText } from "../src/index.js";

describe("formatTimestamp", () => {
  it("formats seconds as HH:MM:SS", () => {
    expect(formatTimestamp(0)).toBe("00:00:00");
    expect(formatTimestamp(83)).toBe("00:01:23");
    expect(formatTimestamp(3661)).toBe("01:01:01");
  });
});

describe("segmentsToPlainText", () => {
  it("renders timestamped lines with optional speaker", () => {
    const text = segmentsToPlainText([
      { start: 0, end: 4, text: "Hello", speaker: "You" },
      { start: 12, end: 20, text: "World", speaker: "Others" },
    ]);
    expect(text).toBe("[00:00:00] You: Hello\n[00:00:12] Others: World");
  });
});
