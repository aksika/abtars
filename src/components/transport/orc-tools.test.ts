/**
 * orc-tools.test.ts — #1728 yield_turn boundary contract: context requirement,
 * pre-handoff rejection, one-shot latch win, and bounded repeat behavior.
 */
import { describe, it, expect } from "vitest";
import { getOrcTools } from "./orc-tools.js";
import type { OrcInvocationContextV2, OrcTurnControl, OrcTurnTerminal } from "../orc-project/orc-project-contracts.js";

const EXEC_CONTEXT: OrcInvocationContextV2 = {
  version: 2,
  runId: "or_1",
  intentKey: "execute:1:1",
  intentKind: "project_execution",
  projectCardId: 1,
  projectGeneration: 1,
  ownershipGeneration: 1,
  ownerPeer: "kp",
  ownerInstanceId: "inst",
  origin: { kind: "local" },
};

function makeControl(satisfies: () => boolean): OrcTurnControl & { wins: number } {
  let completed: OrcTurnTerminal | null = null;
  const control = {
    runId: "or_1",
    get completed(): OrcTurnTerminal | null { return completed; },
    wins: 0,
    complete(terminal: OrcTurnTerminal): boolean {
      if (completed !== null) return false;
      if (!satisfies()) return false;
      completed = terminal;
      control.wins += 1;
      return true;
    },
  };
  return control as unknown as OrcTurnControl & { wins: number };
}

const tool = (): NonNullable<ReturnType<typeof findYield>> => findYield()!;
function findYield() {
  return getOrcTools().find(t => t.name === "yield_turn");
}

function ctx(control?: OrcTurnControl, intentKind = "project_execution"): never {
  return { orcContext: { ...EXEC_CONTEXT, intentKind }, orcTurnControl: control } as never;
}

describe("#1728 yield_turn", () => {
  it("exists on the Orc tool surface", () => {
    expect(findYield()).toBeDefined();
  });

  it("rejects without a bound project_execution context or host turn control", async () => {
    expect(await tool().execute({}, ctx(makeControl(() => true), "project_review"))).toContain("[err]");
    expect(await tool().execute({}, undefined as never)).toContain("[err]");
    expect(await tool().execute({}, { orcContext: { ...EXEC_CONTEXT, intentKind: "project_execution" } } as never)).toContain("[err]");
  });

  it("keeps the turn alive when the durable postcondition is unsatisfied", async () => {
    const control = makeControl(() => false);
    const result = await tool().execute({}, ctx(control));
    expect(result).toContain("[err]");
    expect(result).not.toContain("turn already completed");
    expect(control.completed).toBeNull();
    expect(control.wins).toBe(0);
  });

  it("wins the latch exactly once after the durable handoff; repeats are bounded errors", async () => {
    const control = makeControl(() => true);
    const ok = await tool().execute({}, ctx(control));
    expect(ok).toContain("✓");
    expect(control.wins).toBe(1);
    expect(control.completed).toMatchObject({ kind: "intent_satisfied", code: "project_execution_handed_off" });

    const repeat = await tool().execute({}, ctx(control));
    expect(repeat).toContain("[err] turn already completed");
    expect(control.wins).toBe(1);
    expect(control.completed).toMatchObject({ kind: "intent_satisfied", code: "project_execution_handed_off" });
  });
});
