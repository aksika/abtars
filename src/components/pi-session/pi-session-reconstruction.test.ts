import { describe, expect, it } from "vitest";
import {
  memoryReconstructionStore,
  reconstructPiConversation,
  type PiReconstructionWriter,
  type PiSeedMessage,
} from "./pi-session-reconstruction.js";

function writer(): PiReconstructionWriter & { appended: PiSeedMessage[] } {
  const appended: PiSeedMessage[] = [];
  return {
    appended,
    appendSeed: (message: PiSeedMessage) => {
      appended.push(message);
    },
  };
}

const ARCHIVE: PiSeedMessage[] = [
  { role: "user", text: "first", timestamp: 1 },
  { role: "assistant", text: "second", timestamp: 2 },
];

describe("pi-session-reconstruction", () => {
  it("seeds archive history once and admits the current input once", () => {
    const seed = writer();
    const store = memoryReconstructionStore();
    const consumed = new Set<string>();

    const report = reconstructPiConversation(
      seed,
      store,
      "new-id",
      ARCHIVE,
      { text: "now", timestamp: 3, operationKey: "op-1" },
      (key) => consumed.has(key),
      (key) => {
        consumed.add(key);
      },
    );

    expect(seed.appended.map((message) => message.text)).toEqual(["first", "second", "now"]);
    expect(report).toMatchObject({ successorId: "new-id", seededCount: 2, archiveTotal: 2, currentInputAdmitted: true });
    expect(report.losses).toContain("branch structure");
    expect(consumed.has("op-1")).toBe(true);
  });

  it("resumes after a crash without duplicating seeded history or replaying input", () => {
    const seed = writer();
    const store = memoryReconstructionStore();
    const consumed = new Set<string>(["op-1"]);
    store.saveProgress("new-id", { seeded: 1, currentAdmitted: true });

    const report = reconstructPiConversation(
      seed,
      store,
      "new-id",
      ARCHIVE,
      { text: "now", timestamp: 3, operationKey: "op-1" },
      (key) => consumed.has(key),
      (key) => {
        consumed.add(key);
      },
    );

    expect(seed.appended.map((message) => message.text)).toEqual(["second"]);
    expect(report).toMatchObject({ seededCount: 2, currentInputAdmitted: true });
  });

  it("never replays an already-consumed input as new history", () => {
    const seed = writer();
    const store = memoryReconstructionStore();
    const consumed = new Set<string>(["op-9"]);

    reconstructPiConversation(
      seed,
      store,
      "new-id",
      [],
      { text: "now", timestamp: 3, operationKey: "op-9" },
      (key) => consumed.has(key),
      (key) => {
        consumed.add(key);
      },
    );

    expect(seed.appended).toEqual([]);
  });
});
