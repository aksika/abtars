import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_HOME = mkdtempSync(join(tmpdir(), "abtars-config-show-"));

vi.mock("../../paths.js", () => ({
  abtarsHome: () => TEST_HOME,
}));
vi.mock("./banner.js", () => ({ printBanner: vi.fn(async () => undefined) }));

const { configShow } = await import("./config-show.js");

describe("config-show credential display (#1354)", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_HOME, "config"), { recursive: true });
    writeFileSync(join(TEST_HOME, "config", ".env"), [
      "DEFAULT_MODEL=visible-setting",
      "OPENAI_API_KEY=sk-config-show-sentinel-1234567890",
      "CUSTOM_API_ID=api-id-config-show-sentinel",
      "WEB_AUTH=dashboard-config-show-sentinel",
      "EMPTY_TOKEN=",
      "",
    ].join("\n"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(join(TEST_HOME, "config"), { recursive: true, force: true });
  });

  it("shows presence only for API IDs, WEB_AUTH, and credential-shaped names", async () => {
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    expect(await configShow()).toBe(0);
    const text = output.join("");
    expect(text).toContain("DEFAULT_MODEL=visible-setting");
    expect(text).toContain("OPENAI_API_KEY=(set)");
    expect(text).toContain("CUSTOM_API_ID=(set)");
    expect(text).toContain("WEB_AUTH=(set)");
    expect(text).toContain("EMPTY_TOKEN=(not set)");
    expect(text).not.toContain("sk-config-show-sentinel-1234567890");
    expect(text).not.toContain("api-id-config-show-sentinel");
    expect(text).not.toContain("dashboard-config-show-sentinel");
  });
});
