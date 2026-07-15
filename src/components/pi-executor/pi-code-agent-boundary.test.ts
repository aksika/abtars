import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..", "..");

describe("pi-coding-agent dependency boundary (#1426)", () => {
  it("@earendil-works/pi-coding-agent is a devDependency, not a production dependency", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["@earendil-works/pi-coding-agent"]).toBeUndefined();
    expect(pkg.devDependencies?.["@earendil-works/pi-coding-agent"]).toBeDefined();
  });

  it("esbuild external list does not include pi-coding-agent (type-only usage)", () => {
    const esbuildConfig = readFileSync(resolve(ROOT, "esbuild.config.js"), "utf-8");
    expect(esbuildConfig).not.toContain("pi-coding-agent");
  });

  it("official RPC types can be imported (type-only, compile-time contract)", () => {
    const pkg = JSON.parse(
      readFileSync(
        resolve(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
        "utf-8",
      ),
    ) as { version: string };
    expect(pkg.version).toMatch(/^0\.80\./);
  });

  it("deleted pi-rpc-types.ts — no invented protocol file remains", () => {
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    expect(existsSync(resolve(ROOT, "src", "components", "pi-executor", "pi-rpc-types.ts"))).toBe(false);
  });

  it("no {cmd,args} command envelope remains in SupervisedPiRpcClient", () => {
    const src = readFileSync(
      resolve(ROOT, "src", "components", "pi-executor", "pi-rpc-client.ts"),
      "utf-8",
    );
    expect(src).not.toContain(`"cmd"`);
    expect(src).not.toContain(`"args"`);
    expect(src).not.toContain(`{ok, result, event, data}`);
    expect(src).not.toContain(`--rpc-version`);
    expect(src).not.toContain(`--session-storage-root`);
  });
});
