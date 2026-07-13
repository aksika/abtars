import { describe, it, expect } from "vitest";
import { parsePmsetSchedOutput } from "./pmset-parser.js";

const MOLTY_FIXTURE = `Repeating power events:
  wakepoweron at 7:55AM every day

Scheduled power events:
  07/11/26 14:00:00 wakeorpoweron at 14:00:00
  07/11/26 15:00:00 wakeorpoweron at 15:00:00
  07/11/26 22:30:00 wakeorpoweron at 22:30:00
  07/12/26 07:55:00 wakeorpoweron at 07:55:00
`;

describe("parsePmsetSchedOutput", () => {
  it("parses Molty fixture and matches 07:55", () => {
    const r = parsePmsetSchedOutput(MOLTY_FIXTURE, "07:55");
    expect(r.verified).toBe(true);
    expect(r.kind).toBe("wakepoweron");
    expect(r.localTime).toBe("07:55");
    expect(r.repeating).toBe(true);
  });

  it("tolerates one-minute difference", () => {
    const r = parsePmsetSchedOutput(MOLTY_FIXTURE, "07:54");
    expect(r.verified).toBe(true);
  });

  it("rejects mismatched time", () => {
    const r = parsePmsetSchedOutput(MOLTY_FIXTURE, "08:00");
    expect(r.verified).toBe(false);
    expect(r.reason).toContain("expected");
  });

  it("rejects missing repeating section", () => {
    const r = parsePmsetSchedOutput("Scheduled power events:\n  07/11/26 14:00:00 wakeorpoweron at 14:00\n", "07:55");
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("no repeating wake event found");
  });

  it("handles 24-hour format", () => {
    const output = `Repeating power events:\n  wake at 22:00 every day\n`;
    const r = parsePmsetSchedOutput(output, "22:00");
    expect(r.verified).toBe(true);
    expect(r.kind).toBe("wake");
  });

  it("handles single-digit hour", () => {
    const output = `Repeating power events:\n  wakepoweron at 7:55 every day\n`;
    const r = parsePmsetSchedOutput(output, "07:55");
    expect(r.verified).toBe(true);
  });

  it("rejects empty output", () => {
    const r = parsePmsetSchedOutput("", "07:55");
    expect(r.verified).toBe(false);
  });

  it("only considers repeating events, ignores dated ones", () => {
    const r = parsePmsetSchedOutput(MOLTY_FIXTURE, "14:00");
    expect(r.verified).toBe(false);
  });
});
