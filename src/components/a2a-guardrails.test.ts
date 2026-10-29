/**
 * a2a-guardrails.test.ts — #1854 incoming A2A guardrail whitelist.
 *
 * The invariants under test are the ones that make this a guardrail: defaults
 * never widen, the file is a ceiling peers.json cannot exceed, trust gates the
 * sections, and a peer-originated command is decided rather than prompted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;

function writeWhitelist(body: unknown): void {
  writeFileSync(join(home, "config", "a2a-guardrails.json"), JSON.stringify(body));
}

function writePeers(peers: Record<string, unknown>): void {
  writeFileSync(
    join(home, "config", "peers.json"),
    JSON.stringify({
      self: { name: "kp", signingKey: "", tribeToken: "" },
      peers,
      maxHops: 12,
      timeoutMs: 60000,
    }),
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "a2a-guardrails-"));
  mkdirSync(join(home, "config"), { recursive: true });
  mkdirSync(join(home, "workspace", "projects", "42"), { recursive: true });
  process.env["ABTARS_HOME"] = home;
  vi.resetModules();
});

afterEach(() => {
  delete process.env["ABTARS_HOME"];
  rmSync(home, { recursive: true, force: true });
});

async function load() {
  return await import("./a2a-guardrails.js");
}

describe("whitelist loading", () => {
  it("defaults all three sections to the projects workspace when the file is absent", async () => {
    const { loadA2AWhitelist, scopeAllows } = await load();
    const w = loadA2AWhitelist();
    for (const scope of [w.R, w.W, w.X]) {
      expect(scopeAllows(scope, join(home, "workspace", "projects", "42", "file.ts"))).toBe(true);
      expect(scopeAllows(scope, join(home, "workspace", "other", "file.ts"))).toBe(false);
      expect(scope).not.toBe("*");
    }
  });

  it("honors a wildcard section", async () => {
    writeWhitelist({ R: ["*"], W: [], X: [] });
    const { loadA2AWhitelist, scopeAllows } = await load();
    const w = loadA2AWhitelist();
    expect(w.R).toBe("*");
    expect(scopeAllows(w.R, "/etc/passwd")).toBe(true);
    expect(scopeAllows(w.W, "/etc/passwd")).toBe(false);
  });

  it("falls back to defaults — never to wildcard — on malformed JSON", async () => {
    writeFileSync(join(home, "config", "a2a-guardrails.json"), "{ not json");
    const { loadA2AWhitelist, scopeAllows } = await load();
    const w = loadA2AWhitelist();
    expect(w.R).not.toBe("*");
    expect(scopeAllows(w.R, "/etc/passwd")).toBe(false);
    expect(scopeAllows(w.R, join(home, "workspace", "projects", "42"))).toBe(true);
  });

  it("drops invalid entries and refuses a bare root", async () => {
    writeWhitelist({ R: ["/", 42, "", join(home, "workspace", "projects")], W: [], X: [] });
    const { loadA2AWhitelist, scopeAllows } = await load();
    const w = loadA2AWhitelist();
    expect(scopeAllows(w.R, "/etc/passwd")).toBe(false);
    expect(scopeAllows(w.R, join(home, "workspace", "projects", "42"))).toBe(true);
  });

  it("re-reads after an operator edit", async () => {
    writeWhitelist({ R: [join(home, "workspace", "projects")], W: [], X: [] });
    const { loadA2AWhitelist, scopeAllows } = await load();
    expect(scopeAllows(loadA2AWhitelist().R, "/tmp/elsewhere")).toBe(false);
    writeFileSync(
      join(home, "config", "a2a-guardrails.json"),
      JSON.stringify({ R: ["/tmp"], W: [], X: [] }) + " ",
    );
    expect(scopeAllows(loadA2AWhitelist().R, "/tmp/elsewhere")).toBe(true);
  });
});

describe("trust bounding", () => {
  it("denies everything for an unknown peer", async () => {
    writePeers({});
    const { resolveA2ACapabilities } = await load();
    const caps = resolveA2ACapabilities("molty");
    expect(caps.read).toEqual([]);
    expect(caps.write).toEqual([]);
    expect(caps.exec).toEqual([]);
  });

  it("denies everything when the origin peer is unresolved", async () => {
    const { resolveA2ACapabilities } = await load();
    expect(resolveA2ACapabilities(null).read).toEqual([]);
  });

  it("gives an enrolled peer read only", async () => {
    writePeers({ molty: { host: "h", port: 1, verifyKey: "k", trust: 1 } });
    const { resolveA2ACapabilities, scopeAllows } = await load();
    const caps = resolveA2ACapabilities("molty");
    expect(scopeAllows(caps.read, join(home, "workspace", "projects", "42"))).toBe(true);
    expect(caps.write).toEqual([]);
    expect(caps.exec).toEqual([]);
  });

  it("gives a trusted peer read, write and execute", async () => {
    writePeers({ molty: { host: "h", port: 1, verifyKey: "k", trust: 2 } });
    const { resolveA2ACapabilities, scopeAllows } = await load();
    const caps = resolveA2ACapabilities("molty");
    const inside = join(home, "workspace", "projects", "42");
    expect(scopeAllows(caps.read, inside)).toBe(true);
    expect(scopeAllows(caps.write, inside)).toBe(true);
    expect(scopeAllows(caps.exec, inside)).toBe(true);
  });

  it("ignores per-peer path lists — the global whitelist is the only source", async () => {
    writeWhitelist({ R: [join(home, "workspace", "projects")], W: [], X: [] });
    writePeers({
      molty: {
        host: "h", port: 1, verifyKey: "k", trust: 2,
        // #1854: these keys are no longer part of the schema. Even when an
        // operator leaves them in the file, they must not widen or narrow.
        allowedRead: ["/etc"],
        allowedWrite: ["*"],
      },
    });
    const { resolveA2ACapabilities, scopeAllows } = await load();
    const caps = resolveA2ACapabilities("molty");
    expect(scopeAllows(caps.read, "/etc/passwd")).toBe(false);
    expect(scopeAllows(caps.read, join(home, "workspace", "projects", "43"))).toBe(true);
    // W is empty in the whitelist, so a "*" peer entry grants nothing.
    expect(scopeAllows(caps.write, join(home, "workspace", "projects", "43"))).toBe(false);
  });
});

describe("enforcement through the authorization owner", () => {
  const trustedPeer = { host: "h", port: 1, verifyKey: "k", trust: 2 };

  it("denies a peer command outside the X scope instead of prompting", async () => {
    writePeers({ molty: trustedPeer });
    const { authorizeBashCommand } = await import("./authorization.js");
    const gate = { requestAuth: vi.fn() };
    const decision = await authorizeBashCommand("ls", {
      cwd: "/tmp",
      actionGate: gate as never,
      origin: { kind: "peer", sourcePeer: "molty" },
    });
    expect(decision.decision).toBe("block");
    expect(decision.by).toBe("a2a-whitelist");
    expect(gate.requestAuth).not.toHaveBeenCalled();
  });

  it("allows a peer command inside the X scope", async () => {
    writePeers({ molty: trustedPeer });
    const { authorizeBashCommand } = await import("./authorization.js");
    const decision = await authorizeBashCommand("ls", {
      cwd: join(home, "workspace", "projects", "42"),
      actionGate: null,
      origin: { kind: "peer", sourcePeer: "molty" },
    });
    expect(decision.decision).toBe("allow");
    expect(decision.by).toBe("a2a-whitelist");
  });

  it("refuses an auth-required command from a peer without asking the master", async () => {
    writePeers({ molty: trustedPeer });
    const { authorizeBashCommand } = await import("./authorization.js");
    const gate = { requestAuth: vi.fn().mockResolvedValue({ granted: true, by: "once" }) };
    const decision = await authorizeBashCommand("sudo id", {
      cwd: join(home, "workspace", "projects", "42"),
      actionGate: gate as never,
      origin: { kind: "peer", sourcePeer: "molty" },
    });
    expect(decision.decision).toBe("block");
    expect(gate.requestAuth).not.toHaveBeenCalled();
  });

  it("denies an unknown-origin execution (fail closed)", async () => {
    writePeers({ molty: trustedPeer });
    const { authorizeBashCommand } = await import("./authorization.js");
    const decision = await authorizeBashCommand("ls", {
      cwd: join(home, "workspace", "projects", "42"),
      actionGate: null,
      origin: { kind: "unknown", sourcePeer: null },
    });
    expect(decision.decision).toBe("block");
  });

  it("leaves owner executions on the interactive path", async () => {
    const { authorizeBashCommand } = await import("./authorization.js");
    const decision = await authorizeBashCommand("ls", {
      cwd: "/tmp",
      actionGate: null,
      origin: { kind: "owner", sourcePeer: null },
    });
    expect(decision.by).not.toBe("a2a-whitelist");
  });

  it("bounds a peer read/write path regardless of a wildcard session policy", async () => {
    writePeers({ molty: trustedPeer });
    const { authorizePath } = await import("./authorization.js");
    const { buildPolicy } = await import("./tool-sandbox.js");
    const wildcard = buildPolicy("owner");
    const origin = { kind: "peer" as const, sourcePeer: "molty" };
    expect(authorizePath("/etc/passwd", "read", wildcard, origin).allowed).toBe(false);
    expect(
      authorizePath(join(home, "workspace", "projects", "42", "x.ts"), "write", wildcard, origin).allowed,
    ).toBe(true);
  });

  it("maps the A2A chat user namespace to a peer origin", async () => {
    const { resolveAuthorizationOrigin } = await import("./authorization.js");
    expect(resolveAuthorizationOrigin({ userId: "peer:molty" })).toEqual({ kind: "peer", sourcePeer: "molty" });
    expect(resolveAuthorizationOrigin({ userId: "master" })).toBeUndefined();
    expect(resolveAuthorizationOrigin({ workOrigin: { rootKind: "peer", sourcePeer: "molty" } }))
      .toEqual({ kind: "peer", sourcePeer: "molty" });
    expect(resolveAuthorizationOrigin({ workOrigin: { rootKind: "unknown", sourcePeer: null } }))
      .toEqual({ kind: "unknown", sourcePeer: null });
    expect(resolveAuthorizationOrigin({ workOrigin: { rootKind: "interactive", sourcePeer: null } }))
      .toEqual({ kind: "owner", sourcePeer: null });
  });
});

describe("peers.json allowedTools", () => {
  it("grants no tools when the entry omits allowedTools", async () => {
    writePeers({ molty: { host: "h", port: 1, verifyKey: "k", trust: 2 } });
    const { a2aSandboxPolicy } = await load();
    const policy = a2aSandboxPolicy("molty");
    expect(policy.allowedTools).toEqual([]);
    expect(policy.canExecuteBash).toBe(false);
  });

  it("grants exactly the listed tools", async () => {
    writePeers({ molty: { host: "h", port: 1, verifyKey: "k", trust: 2, allowedTools: ["file_read", "web_fetch"] } });
    const { a2aSandboxPolicy, resolveA2ACapabilities, toolScopeAllows } = await load();
    expect(a2aSandboxPolicy("molty").allowedTools).toEqual(["file_read", "web_fetch"]);
    const caps = resolveA2ACapabilities("molty");
    expect(toolScopeAllows(caps, "file_read")).toBe(true);
    expect(toolScopeAllows(caps, "execute_bash")).toBe(false);
  });

  it("honors a wildcard tool list", async () => {
    writePeers({ molty: { host: "h", port: 1, verifyKey: "k", trust: 2, allowedTools: ["*"] } });
    const { a2aSandboxPolicy } = await load();
    const policy = a2aSandboxPolicy("molty");
    expect(policy.allowedTools).toEqual(["*"]);
    expect(policy.canExecuteBash).toBe(true);
  });

  it("refuses bash when the X scope is empty even if the tool is listed", async () => {
    writeWhitelist({ R: [join(home, "workspace", "projects")], W: [], X: [] });
    writePeers({ molty: { host: "h", port: 1, verifyKey: "k", trust: 2, allowedTools: ["execute_bash"] } });
    const { a2aSandboxPolicy } = await load();
    expect(a2aSandboxPolicy("molty").canExecuteBash).toBe(false);
  });

  it("grants no tools below trust 1 regardless of the entry", async () => {
    writePeers({ molty: { host: "h", port: 1, verifyKey: "k", trust: 0, allowedTools: ["*"] } });
    const { a2aSandboxPolicy } = await load();
    expect(a2aSandboxPolicy("molty").allowedTools).toEqual([]);
  });

  it("refuses an unlisted tool at the dispatch boundary", async () => {
    writePeers({ molty: { host: "h", port: 1, verifyKey: "k", trust: 2, allowedTools: ["file_read"] } });
    const { authorizeA2ATool } = await import("./authorization.js");
    const origin = { kind: "peer" as const, sourcePeer: "molty" };
    expect(authorizeA2ATool("file_read", origin).allowed).toBe(true);
    expect(authorizeA2ATool("execute_bash", origin).allowed).toBe(false);
    // Owner executions are untouched by the peer tool list.
    expect(authorizeA2ATool("execute_bash", { kind: "owner", sourcePeer: null }).allowed).toBe(true);
    expect(authorizeA2ATool("execute_bash", undefined).allowed).toBe(true);
  });

  it("refuses every tool for an unknown peer", async () => {
    writePeers({});
    const { authorizeA2ATool } = await import("./authorization.js");
    expect(authorizeA2ATool("file_read", { kind: "peer", sourcePeer: "ghost" }).allowed).toBe(false);
  });
});
