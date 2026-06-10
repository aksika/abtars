import { describe, it, expect } from "vitest";
import { shouldSandbox, ALWAYS_GATE } from "./command-safety.js";

describe("shouldSandbox", () => {
  it("bypasses bare safe commands", () => {
    expect(shouldSandbox("date")).toBe(false);
    expect(shouldSandbox("pwd")).toBe(false);
    expect(shouldSandbox("whoami")).toBe(false);
  });

  it("sandboxes safe commands with arguments", () => {
    expect(shouldSandbox("date -u")).toBe(true);
    expect(shouldSandbox("cat /etc/passwd")).toBe(true);
  });

  it("sandboxes unknown commands", () => {
    expect(shouldSandbox("curl https://example.com")).toBe(true);
    expect(shouldSandbox("npm install")).toBe(true);
    expect(shouldSandbox("rm -rf /tmp/test")).toBe(true);
  });

  it("sandboxes commands with shell operators", () => {
    expect(shouldSandbox("echo hi > /tmp/test")).toBe(true);
    expect(shouldSandbox("cat foo | grep bar")).toBe(true);
    expect(shouldSandbox("ls && rm file")).toBe(true);
    expect(shouldSandbox("echo $(whoami)")).toBe(true);
  });
});

describe("ALWAYS_GATE", () => {
  it("matches destructive patterns", () => {
    expect(ALWAYS_GATE.test("rm -rf /tmp/project")).toBe(true);
    expect(ALWAYS_GATE.test("git push --force")).toBe(true);
    expect(ALWAYS_GATE.test("DROP TABLE users")).toBe(true);
    expect(ALWAYS_GATE.test("chmod 777 /etc")).toBe(true);
  });

  it("does not match safe commands", () => {
    expect(ALWAYS_GATE.test("ls -la")).toBe(false);
    expect(ALWAYS_GATE.test("git push origin dev")).toBe(false);
    expect(ALWAYS_GATE.test("rm file.txt")).toBe(false);
  });
});
