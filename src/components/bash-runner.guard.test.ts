import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(src: string): string {
  return readFileSync(join(process.cwd(), src), "utf-8");
}

describe("#1716 single-runner guard", () => {
  it("no bash timeout constant survives outside the env schema", () => {
    for (const file of [
      "src/components/host-tool-service.ts",
      "src/components/transport/tool-registry.ts",
      "src/components/bash-runner.ts",
    ]) {
      expect(read(file).match(/BASH_TIMEOUT_MS/g)).toBeNull();
    }
  });

  it("both call sites route through the canonical runner", () => {
    expect(read("src/components/host-tool-service.ts")).toContain('from "./bash-runner.js"');
    expect(read("src/components/transport/tool-registry.ts")).toContain('from "../bash-runner.js"');
  });

  it("the cap is configured through the canonical env schema", () => {
    const schema = read("src/components/env-schema.ts");
    expect(schema).toContain("BASH_TOOL_TIMEOUT_SEC");
    expect(schema).toContain("bashToolTimeoutSec");
    const service = read("src/components/host-tool-service.ts");
    expect(service).toContain("getEnv().bashToolTimeoutSec");
    expect(service.match(/WATCHDOG_TOOL_TIMEOUT_SEC/)).toBeNull();
  });
});
