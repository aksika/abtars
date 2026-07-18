import type { WakeVerification } from "./types.js";

const WAKE_LINE_RE = /^\s*(wake|wakepoweron)\s+at\s+(\d{1,2}:\d{2})(?:AM|PM)?\s+every\s+day\s*$/im;

export function parsePmsetSchedOutput(output: string, expectedLocalTime: string): WakeVerification {
  const lines = output.split("\n");
  let repeatingSection = false;
  let repeatedWake: { kind: "wake" | "wakepoweron"; time: string } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^Repeating power events:/i.test(trimmed)) {
      repeatingSection = true;
      continue;
    }
    if (/^Scheduled power events:/i.test(trimmed)) {
      repeatingSection = false;
      continue;
    }
    if (/^\s*$/.test(trimmed)) continue;

    if (repeatingSection) {
      const m = trimmed.match(WAKE_LINE_RE);
      if (m) {
        const kind = m[1] as "wake" | "wakepoweron";
        const time = normalizeTime(m[2]!);
        if (!repeatedWake) {
          repeatedWake = { kind, time };
        }
      }
    }
  }

  if (!repeatedWake) {
    return { verified: false, reason: "no repeating wake event found" };
  }

  const expected = normalizeTime(expectedLocalTime);
  const actual = repeatedWake.time;

  if (actual === expected || withinTolerance(actual, expected)) {
    return {
      verified: true,
      kind: repeatedWake.kind,
      localTime: repeatedWake.time,
      repeating: true,
    };
  }

  return {
    verified: false,
    kind: repeatedWake.kind,
    localTime: repeatedWake.time,
    repeating: true,
    reason: `expected ${expectedLocalTime} but found ${repeatedWake.time}`,
  };
}

function normalizeTime(t: string): string {
  const parts = t.split(":");
  const h = parts[0]!.padStart(2, "0");
  const m = parts[1]!.padStart(2, "0");
  return `${h}:${m}`;
}

function withinTolerance(actual: string, expected: string): boolean {
  const [ah, am] = actual.split(":").map(Number);
  const [eh, em] = expected.split(":").map(Number);
  const aMin = ah! * 60 + am!;
  const eMin = eh! * 60 + em!;
  return Math.abs(aMin - eMin) <= 1;
}
