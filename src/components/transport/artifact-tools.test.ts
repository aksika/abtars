import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock the S3 store (artifact_push/pull depend on it)
vi.mock("../artifact-store.js", () => ({
  upload: vi.fn().mockRejectedValue(new Error("Artifact store not configured")),
  download: vi.fn().mockRejectedValue(new Error("Artifact store not configured")),
}));

import { artifactAttachTool, artifactPushTool, artifactPullTool, drainArtifacts } from "./artifact-tools.js";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "art-tools-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true });
});

describe("artifact_attach tool", () => {
  it("reads a file, base64-encodes, and stores in queue", async () => {
    const filePath = join(tmpDir, "hello.txt");
    writeFileSync(filePath, "hello world");

    const result = JSON.parse(await artifactAttachTool.execute({ path: filePath, card_id: "42" }));
    expect(result.ok).toBe(true);
    expect(result.name).toBe("hello.txt");
    expect(result.size).toBe(11);
    expect(result.queued).toBe(1);

    const arts = drainArtifacts(42);
    expect(arts).toHaveLength(1);
    expect(arts![0].name).toBe("hello.txt");
    expect(Buffer.from(arts![0].content, "base64").toString()).toBe("hello world");
  });

  it("rejects files > 1MB", async () => {
    const bigFile = join(tmpDir, "big.bin");
    writeFileSync(bigFile, Buffer.alloc(1_000_001));

    const result = JSON.parse(await artifactAttachTool.execute({ path: bigFile, card_id: "99" }));
    expect(result.error).toMatch(/File too large/);
  });
});

describe("drainArtifacts", () => {
  it("returns queued artifacts and clears the queue", async () => {
    const filePath = join(tmpDir, "drain.txt");
    writeFileSync(filePath, "data");

    await artifactAttachTool.execute({ path: filePath, card_id: "100" });
    const arts = drainArtifacts(100);
    expect(arts).toHaveLength(1);

    // Second drain returns undefined (cleared)
    expect(drainArtifacts(100)).toBeUndefined();
  });

  it("returns undefined when nothing queued", () => {
    expect(drainArtifacts(999)).toBeUndefined();
  });
});

describe("artifact_push tool", () => {
  it("returns error when S3 not configured", async () => {
    const result = JSON.parse(await artifactPushTool.execute({ local_path: "/tmp/x", remote_path: "k" }));
    expect(result.error).toBe("Artifact store not configured");
  });
});

describe("artifact_pull tool", () => {
  it("returns error when S3 not configured", async () => {
    const result = JSON.parse(await artifactPullTool.execute({ remote_path: "k", local_path: "/tmp/x" }));
    expect(result.error).toBe("Artifact store not configured");
  });
});
