import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleOrcSpawn, handleOrcStatus, handleOrcCancel, handleOrcDelegate, handleKanbanCreate,
} from "./agent-api-local-routes.js";
import type { AgentApiLocalRouteDeps } from "./agent-api-local-routes.js";

const originalHome = process.env.HOME;

function makeRes() {
  const written: { status?: number; body?: string } = {};
  const res = {
    writeHead(status: number) { written.status = status; return res; },
    end(body?: string) { written.body = body; },
    _written: written,
  } as any;
  return res;
}

function toolStub(name: string, result: unknown = "ok") {
  return { name, description: name, parameters: {}, execute: async () => typeof result === "string" ? result : JSON.stringify(result) };
}

describe("local Orc handlers (#1557)", () => {
  it("spawn selects the spawn_worker tool and serializes the result", async () => {
    const calls: string[] = [];
    const deps: AgentApiLocalRouteDeps = {
      getOrcTools: async () => [
        toolStub("check_workers"),
        toolStub("spawn_worker", { worker: "w1" }),
        toolStub("cancel_worker"),
      ].map(t => ({ ...t, execute: async (args: Record<string, unknown>) => { calls.push(`spawn:${JSON.stringify(args)}`); return JSON.stringify({ worker: "w1" }); } })),
    };
    const res = makeRes();
    await handleOrcSpawn({ count: 2 }, res, deps);
    expect(calls).toEqual(["spawn:{\"count\":2}"]);
    expect(res._written.status).toBe(200);
    // Production orc tools return strings; the handler wraps them unchanged.
    expect(JSON.parse(res._written.body!)).toEqual({ ok: true, result: "{\"worker\":\"w1\"}" });
  });

  it("status selects the check_workers tool with an empty arg map", async () => {
    const calls: string[] = [];
    const deps: AgentApiLocalRouteDeps = {
      getOrcTools: async () => [{
        name: "check_workers", description: "", parameters: {},
        execute: async (args: Record<string, unknown>) => { calls.push(`status:${JSON.stringify(args)}`); return JSON.stringify({ running: 0 }); },
      }],
    };
    const res = makeRes();
    await handleOrcStatus(res, deps);
    expect(calls).toEqual(["status:{}"]);
    expect(res._written.status).toBe(200);
  });

  it("cancel selects the cancel_worker tool and forwards the body", async () => {
    const calls: string[] = [];
    const deps: AgentApiLocalRouteDeps = {
      getOrcTools: async () => [{
        name: "cancel_worker", description: "", parameters: {},
        execute: async (args: Record<string, unknown>) => { calls.push(`cancel:${JSON.stringify(args)}`); return JSON.stringify({ cancelled: 1 }); },
      }],
    };
    const res = makeRes();
    await handleOrcCancel({ worker_id: "w7" }, res, deps);
    expect(calls).toEqual(["cancel:{\"worker_id\":\"w7\"}"]);
    expect(res._written.status).toBe(200);
  });

  it("surfaces tool failures as { ok:false } 500", async () => {
    const deps: AgentApiLocalRouteDeps = {
      getOrcTools: async () => [{
        name: "spawn_worker", description: "", parameters: {},
        execute: async () => { throw new Error("no capacity"); },
      }],
    };
    const res = makeRes();
    await handleOrcSpawn({}, res, deps);
    expect(res._written.status).toBe(500);
    expect(JSON.parse(res._written.body!).error).toContain("no capacity");
  });
});

describe("handleOrcDelegate (#1618)", () => {
  it("rejects missing peer/goal with 400 before any service call", async () => {
    let called = false;
    const res = makeRes();
    await handleOrcDelegate({ peer: "molty" }, res, {
      getRequesterContributionService: () => ({ delegate: async () => { called = true; return {} as any; } }) as any,
    });
    expect(res._written.status).toBe(400);
    expect(JSON.parse(res._written.body!).error).toBe("peer and goal required");
    expect(called).toBe(false);
  });

  it("delegates through the injected service with a generated request id", async () => {
    let input: any;
    const res = makeRes();
    await handleOrcDelegate({ peer: "molty", goal: "build the thing", priority: "HIGH" }, res, {
      now: () => new Date(1_700_000_000_000),
      getRequesterContributionService: () => ({
        delegate: async (i: any) => {
          input = i;
          return {
            decision: "accepted", projectCardId: 11, proxyCardId: 12, requestId: "orc_1700000000000",
            contributionRef: "help_1", response: { version: 1, request_id: "r", decision: "accepted" as const, contribution_ref: "help_1" },
          };
        },
      }) as any,
    });
    expect(res._written.status).toBe(200);
    const out = JSON.parse(res._written.body!);
    expect(out).toEqual({
      ok: true, decision: "accepted", project_card_id: 11, proxy_card_id: 12,
      request_id: "orc_1700000000000", contribution_ref: "help_1",
      reason_code: undefined, reason: undefined,
    });
    expect(input.request.priority).toBe("HIGH");
    expect(input.request.created_at).toBe("2023-11-14T22:13:20.000Z");
    expect(input.binding.kind).toBe("create_cli_project");
    expect(input.binding.title).toBe("[delegate:molty] build the thing");
  });

  it("preserves an explicit request_id", async () => {
    let input: any;
    const res = makeRes();
    await handleOrcDelegate({ peer: "molty", goal: "g", request_id: "orc_route_1" }, res, {
      getRequesterContributionService: () => ({
        delegate: async (i: any) => { input = i; return { decision: "accepted", projectCardId: 1, proxyCardId: 2, requestId: "orc_route_1", contributionRef: "c" }; },
      }) as any,
    });
    expect(input.request.request_id).toBe("orc_route_1");
  });
});

describe("handleKanbanCreate (#955)", () => {
  it("returns 201 with card id on success and passes mapped input", async () => {
    let input: any;
    const res = makeRes();
    await handleKanbanCreate(
      { type: "task", title: "t", goal: "g", source: "web", priority: "HIGH", labels: "a,b", delivery_mode: "silent", chat_id: "c1" },
      res,
      { createDispatchableCard: (i) => { input = i; return { cardId: 42, status: "queued" }; } },
    );
    expect(res._written.status).toBe(201);
    expect(JSON.parse(res._written.body!)).toEqual({ ok: true, card_id: 42, status: "queued" });
    expect(input).toEqual({ type: "task", title: "t", goal: "g", source: "web", priority: "HIGH", labels: "a,b", deliveryMode: "silent", chatId: "c1" });
  });

  it("defaults source to cli and returns 400 on validation errors", async () => {
    let input: any;
    const res = makeRes();
    await handleKanbanCreate({ type: "task", title: "t" }, res, {
      createDispatchableCard: (i) => { input = i; return { error: "goal required for B cards" }; },
    });
    expect(input.source).toBe("cli");
    expect(res._written.status).toBe(400);
    expect(JSON.parse(res._written.body!)).toEqual({ ok: false, error: "goal required for B cards" });
  });
});

describe("local routes production defaults", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "localroutes-"));
    process.env.HOME = tmpDir;
    mkdirSync(join(tmpDir, ".abtars", "logs"), { recursive: true });
    if (originalHome) {
      mkdirSync(join(tmpDir, ".local", "lib"), { recursive: true });
      const link = join(tmpDir, ".local", "lib", "node_modules");
      if (!existsSync(link)) {
        writeFileSync(join(tmpDir, ".abtars", "kanban"), "");
        try { require("node:fs").symlinkSync(join(originalHome, ".local", "lib", "node_modules"), link, "dir"); } catch { /* no global modules */ }
      }
    }
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("kanban create runs against the production card creation path", async () => {
    const res = makeRes();
    await handleKanbanCreate({ type: "task", title: "prod-card", goal: "g" }, res, {});
    // Real validation either creates the card (201) or rejects (400); the
    // production path must be reachable without a server.
    expect([201, 400]).toContain(res._written.status);
  });

  it("orc status runs against the production tool registry", async () => {
    const res = makeRes();
    await handleOrcStatus(res, {});
    expect(res._written.status).toBe(200);
    expect(JSON.parse(res._written.body!).ok).toBe(true);
  });
});
