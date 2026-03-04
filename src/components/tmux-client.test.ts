import { describe, it, expect, vi, beforeEach } from "vitest";
import { TmuxClient } from "./tmux-client.js";
import * as child_process from "node:child_process";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

describe("TmuxClient", () => {
  let client: TmuxClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    client = new TmuxClient("test-session", 0.1, 5);
  });

  describe("initialize", () => {
    it("succeeds when tmux session exists", async () => {
      vi.mocked(child_process.execSync).mockReturnValue("");
      await expect(client.initialize()).resolves.toBeUndefined();
      expect(client.isReady).toBe(true);
    });

    it("throws when tmux session does not exist", async () => {
      vi.mocked(child_process.execSync).mockImplementation(() => {
        throw new Error("session not found");
      });
      await expect(client.initialize()).rejects.toThrow("not found");
    });
  });

  describe("isReady", () => {
    it("returns false before initialization", () => {
      expect(client.isReady).toBe(false);
    });
  });

  describe("destroy", () => {
    it("sets ready to false", async () => {
      vi.mocked(child_process.execSync).mockReturnValue("");
      await client.initialize();
      expect(client.isReady).toBe(true);
      client.destroy();
      expect(client.isReady).toBe(false);
    });
  });
});
