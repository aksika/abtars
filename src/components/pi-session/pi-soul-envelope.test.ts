import { describe, expect, it } from "vitest";
import {
  SOUL_BUNDLE_MARKER_CLOSE,
  SOUL_BUNDLE_MARKER_OPEN,
  soulBundleEnvelope,
} from "./pi-soul-envelope.js";

describe("pi-soul-envelope", () => {
  it("marks exactly one current bundle without duplicating its content", () => {
    const envelope = soulBundleEnvelope("BUNDLE-MARKER-1932", { executionId: "exec_1", beforeMessageId: 42 });

    expect(envelope.startsWith(`${SOUL_BUNDLE_MARKER_OPEN} id=exec_1 bundle=`)).toBe(true);
    expect(envelope).toContain("cursor=42");
    expect(envelope.endsWith(`\n${SOUL_BUNDLE_MARKER_CLOSE}`)).toBe(true);
    expect(envelope.match(/BUNDLE-MARKER-1932/g)).toHaveLength(1);
  });

  it("marks an ephemeral turn explicitly", () => {
    const envelope = soulBundleEnvelope("bundle", { executionId: "exec_1" });

    expect(envelope).toContain("cursor=ephemeral");
  });

  it("changes the source hash when bundle content changes", () => {
    const first = soulBundleEnvelope("bundle-a", { executionId: "exec_1", beforeMessageId: 1 });
    const second = soulBundleEnvelope("bundle-b", { executionId: "exec_1", beforeMessageId: 1 });

    expect(first).not.toContain(second.split(" ")[2]);
  });

  it("hashes an unsafe request identifier instead of emitting it", () => {
    const envelope = soulBundleEnvelope("bundle", { executionId: "exec 1\ninjected" });

    expect(envelope).not.toContain("exec 1\ninjected");
    expect(envelope.startsWith(`${SOUL_BUNDLE_MARKER_OPEN} id=`)).toBe(true);
  });
});
