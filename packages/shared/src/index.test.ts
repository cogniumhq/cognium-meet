import { describe, expect, it } from "vitest";
import {
  formatTimestamp,
  mergeTranscriptionProgress,
  parseAudioCaptureMode,
  parseTranscriptionModel,
  segmentsToPlainText,
  transcriptionProgressLabel,
  transcriptionProgressPercent,
} from "../src/index.js";

describe("formatTimestamp", () => {
  it("formats seconds as HH:MM:SS", () => {
    expect(formatTimestamp(0)).toBe("00:00:00");
    expect(formatTimestamp(83)).toBe("00:01:23");
    expect(formatTimestamp(3661)).toBe("01:01:01");
  });
});

describe("transcriptionProgressPercent", () => {
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");

  it("weights progress by audio duration, not part count", () => {
    // 22 min total: part 1 = 20 min, part 2 = 2 min
    const total = 1298;
    const part1 = 1200;

    expect(
      transcriptionProgressPercent(
        {
          phase: "transcribing",
          step: 1,
          totalSteps: 2,
          totalAudioSeconds: total,
          completedAudioSeconds: part1,
        },
        t0,
      ),
    ).toBe(90);

    const at5min = t0 + 5 * 60 * 1000;
    const duringPart1 = transcriptionProgressPercent(
      {
        phase: "transcribing",
        step: 1,
        totalSteps: 2,
        totalAudioSeconds: total,
        completedAudioSeconds: 0,
        partStartedAt: "2026-01-01T00:00:00.000Z",
        partAudioSeconds: part1,
      },
      at5min,
    );
    expect(duringPart1).toBeGreaterThan(10);
    expect(duringPart1).toBeLessThan(50);

    const at70min = t0 + 70 * 60 * 1000;
    const overtime = transcriptionProgressPercent(
      {
        phase: "transcribing",
        step: 1,
        totalSteps: 2,
        totalAudioSeconds: total,
        completedAudioSeconds: 0,
        partStartedAt: "2026-01-01T00:00:00.000Z",
        partAudioSeconds: part1,
      },
      at70min,
    );
    expect(overtime).toBeGreaterThan(duringPart1);
  });

  it("maps saving to near-complete", () => {
    expect(transcriptionProgressPercent({ phase: "saving" }, t0)).toBe(98);
  });

  it("advances quickly for whisper-sized runtimes", () => {
    const total = 1800;
    const at1min = t0 + 60 * 1000;
    const pct = transcriptionProgressPercent(
      {
        phase: "transcribing",
        profile: "whisper",
        step: 1,
        totalSteps: 1,
        totalAudioSeconds: total,
        completedAudioSeconds: 0,
        partStartedAt: "2026-01-01T00:00:00.000Z",
        partAudioSeconds: total,
      },
      at1min,
    );
    expect(pct).toBeGreaterThan(40);
    expect(pct).toBeLessThan(80);
  });
});

describe("transcriptionProgressLabel", () => {
  it("shows audio minutes transcribed", () => {
    const label = transcriptionProgressLabel(
      {
        phase: "transcribing",
        step: 1,
        totalSteps: 2,
        totalAudioSeconds: 1298,
        completedAudioSeconds: 0,
        partStartedAt: "2026-01-01T00:00:00.000Z",
        partAudioSeconds: 1200,
      },
      Date.parse("2026-01-01T00:10:00.000Z"),
    );
    expect(label).toContain("part 1/2");
    expect(label).toContain("of 22 min");
  });
});

describe("mergeTranscriptionProgress", () => {
  it("keeps timing fields when a part-finished snapshot omits partStartedAt", () => {
    const during = {
      phase: "transcribing" as const,
      profile: "diarize" as const,
      step: 1,
      totalSteps: 2,
      totalAudioSeconds: 300,
      completedAudioSeconds: 0,
      partAudioSeconds: 240,
      partStartedAt: "2026-01-01T00:00:00.000Z",
    };
    const finished = {
      phase: "transcribing" as const,
      step: 1,
      totalSteps: 2,
      label: "Part 1/2 finished",
      completedAudioSeconds: 240,
      totalAudioSeconds: 300,
      partAudioSeconds: 240,
    };

    const merged = mergeTranscriptionProgress(during, finished);
    expect(merged.completedAudioSeconds).toBe(240);
    expect(merged.partStartedAt).toBeUndefined();
    expect(
      transcriptionProgressPercent(merged, Date.parse("2026-01-01T00:00:00.000Z")),
    ).toBeGreaterThan(50);
  });

  it("resets partStartedAt when advancing to the next step", () => {
    const part1 = {
      phase: "transcribing" as const,
      step: 1,
      totalSteps: 2,
      totalAudioSeconds: 300,
      completedAudioSeconds: 240,
      partAudioSeconds: 240,
      partStartedAt: "2026-01-01T00:00:00.000Z",
    };
    const part2 = {
      phase: "transcribing" as const,
      step: 2,
      totalSteps: 2,
      label: "Transcribing part 2/2…",
      totalAudioSeconds: 300,
      completedAudioSeconds: 240,
      partAudioSeconds: 60,
      partStartedAt: "2026-01-01T00:40:00.000Z",
    };

    const merged = mergeTranscriptionProgress(part1, part2);
    expect(merged.step).toBe(2);
    expect(merged.partStartedAt).toBe("2026-01-01T00:40:00.000Z");
    expect(merged.completedAudioSeconds).toBe(240);
  });
});

describe("parseTranscriptionModel", () => {
  it("accepts known models and falls back otherwise", () => {
    expect(parseTranscriptionModel("whisper-1")).toBe("whisper-1");
    expect(parseTranscriptionModel("gpt-4o-transcribe-diarize")).toBe(
      "gpt-4o-transcribe-diarize",
    );
    expect(parseTranscriptionModel("invalid", "whisper-1")).toBe("whisper-1");
  });
});

describe("parseAudioCaptureMode", () => {
  it("accepts known modes and falls back otherwise", () => {
    expect(parseAudioCaptureMode("dual-track")).toBe("dual-track");
    expect(parseAudioCaptureMode("mixed")).toBe("mixed");
    expect(parseAudioCaptureMode("invalid", "dual-track")).toBe("dual-track");
  });
});

describe("segmentsToPlainText", () => {
  it("renders timestamped lines with optional speaker", () => {
    const text = segmentsToPlainText([
      { start: 0, end: 4, text: "Hello", speaker: "Speaker 1" },
      { start: 12, end: 20, text: "World", speaker: "Speaker 2" },
    ]);
    expect(text).toBe("[00:00:00] Speaker 1: Hello\n[00:00:12] Speaker 2: World");
  });
});
