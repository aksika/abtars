/**
 * scripted-provider.1900.test.ts — #1900 R1 focused regressions.
 *
 * Proves through real provider HTTP:
 * - a registered goal beyond 300 chars is recognized (full-text, not preview)
 * - unrelated B traffic stays unscripted (503) and cannot consume scheduled scripts
 * - constrained scheduled scripts win over unconstrained FIFO on the same candidate
 * - provider close terminates held connections instead of hanging
 */

import { describe, it, expect, afterEach } from "vitest";
import { ScriptedProvider } from "./scripted-provider.js";
import { FIXTURE_MODEL_B } from "./bridge-config.js";

const GOAL = "PI-E2E-SCHEDULED scheduled-limit";

let provider: ScriptedProvider | null = null;

afterEach(async () => {
  if (provider) {
    try {
      await provider.close();
    } catch {
      // best effort
    }
    provider = null;
  }
});

async function postChat(baseUrl: string, model: string, userText: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: userText }] }),
  });
  const body = await res.text();
  return { status: res.status, body };
}

describe("#1900 provider full-request recognition", () => {
  it("recognizes a registered goal beyond 300 chars and isolates unrelated traffic", async () => {
    provider = new ScriptedProvider();
    await provider.start();
    provider.registerMarker(GOAL);
    provider.enqueue({
      candidate: FIXTURE_MODEL_B,
      expectation: { candidate: FIXTURE_MODEL_B, orderedContains: [GOAL] },
      action: { kind: "toolCall", name: "execute_bash", arguments: { command: "echo round" } },
    });
    provider.enqueue({
      candidate: FIXTURE_MODEL_B,
      expectation: { candidate: FIXTURE_MODEL_B, orderedContains: [GOAL] },
      action: { kind: "toolCall", name: "execute_bash", arguments: { command: "echo round" } },
    });

    // 400-char prefix pushes the goal beyond the 300-char preview window.
    const late = `${"x".repeat(400)} ${GOAL} tail`;
    const first = await postChat(provider.baseUrl, FIXTURE_MODEL_B, late);
    expect(first.status).toBe(200);

    // Unrelated B traffic must not consume scheduled scripts: 503, no consume.
    const unrelated = await postChat(provider.baseUrl, FIXTURE_MODEL_B, "unrelated worker turn without marker");
    expect(unrelated.status).toBe(503);

    // Second scheduled request still gets its scripted tool response.
    const second = await postChat(provider.baseUrl, FIXTURE_MODEL_B, `prefix ${GOAL}`);
    expect(second.status).toBe(200);

    const summaries = provider.summariesFor(FIXTURE_MODEL_B);
    expect(summaries.length).toBe(3);
    // Full-text recognition: both scheduled summaries carry the bounded identity.
    expect(summaries[0]?.matchedMarkers).toContain(GOAL);
    expect(summaries[2]?.matchedMarkers).toContain(GOAL);
    // Unrelated carries no match and stays unscripted.
    expect(summaries[1]?.matchedMarkers).toEqual([]);
    expect(summaries[1]?.action).toBe("unscripted");
    // Both scheduled responses are toolCalls; unrelated cannot satisfy evidence.
    const toolCalls = summaries.filter((s) => s.matchedMarkers.includes(GOAL) && s.action === "toolCall");
    expect(toolCalls.length).toBe(2);
  });

  it("prefers constrained scheduled scripts over unconstrained FIFO", async () => {
    provider = new ScriptedProvider();
    await provider.start();
    provider.registerMarker(GOAL);
    // Unrelated unconstrained script queued first would previously shadow.
    provider.enqueue({
      candidate: FIXTURE_MODEL_B,
      expectation: undefined,
      action: { kind: "text", chunks: ["unconstrained"] },
    });
    provider.enqueue({
      candidate: FIXTURE_MODEL_B,
      expectation: { candidate: FIXTURE_MODEL_B, orderedContains: [GOAL] },
      action: { kind: "toolCall", name: "execute_bash", arguments: { command: "echo round" } },
    });

    const scheduled = await postChat(provider.baseUrl, FIXTURE_MODEL_B, `hello ${GOAL}`);
    expect(scheduled.status).toBe(200);
    const summaries = provider.summariesFor(FIXTURE_MODEL_B);
    // Scheduled request must receive the constrained toolCall, not the FIFO text.
    expect(summaries[0]?.action).toBe("toolCall");
    expect(summaries[0]?.matchedMarkers).toContain(GOAL);

    // Unrelated request falls back to the unconstrained text script.
    const other = await postChat(provider.baseUrl, FIXTURE_MODEL_B, "plain hello");
    expect(other.status).toBe(200);
    expect(provider.summariesFor(FIXTURE_MODEL_B)[1]?.action).toBe("text");
  });

  it("bounds the marker registry and resets with the fixture lifecycle", async () => {
    provider = new ScriptedProvider();
    await provider.start();
    const registry = provider;
    expect(() => registry.registerMarker("")).toThrow();
    expect(() => registry.registerMarker("x".repeat(257))).toThrow();
    for (let i = 0; i < 8; i++) registry.registerMarker(`marker-${i}`);
    expect(() => registry.registerMarker("marker-overflow")).toThrow();
    registry.clear();
    // After clear the registry resets — registering again succeeds.
    provider.registerMarker(GOAL);
    provider.enqueue({
      candidate: FIXTURE_MODEL_B,
      expectation: { candidate: FIXTURE_MODEL_B, orderedContains: [GOAL] },
      action: { kind: "toolCall", name: "execute_bash", arguments: { command: "echo round" } },
    });
    const res = await postChat(provider.baseUrl, FIXTURE_MODEL_B, `hi ${GOAL}`);
    expect(res.status).toBe(200);
  });

  it("close terminates a held generation instead of hanging", async () => {
    provider = new ScriptedProvider();
    await provider.start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.enqueue({
      candidate: FIXTURE_MODEL_B,
      expectation: undefined,
      action: { kind: "hold", release: gate },
    });
    // Consume the body so the test proves the held stream itself terminates;
    // headers alone resolve immediately and would not prove it.
    const pendingBody = fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: FIXTURE_MODEL_B, messages: [{ role: "user", content: "held turn" }] }),
    }).then((res) => res.text().then(
      () => undefined,
      () => undefined,
    ), () => undefined);
    // Wait until the held request is observed, then close with a real open socket.
    const deadline = Date.now() + 5_000;
    while (provider.requestCount === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(provider.requestCount).toBe(1);
    await provider.close();
    // The held body must settle (abort/close) once the provider is gone;
    // close itself must have resolved above instead of hanging on the socket.
    await Promise.race([
      pendingBody,
      new Promise((_, reject) => setTimeout(() => reject(new Error("held fetch did not settle after provider close")), 5_000)),
    ]);
    // Abort propagates asynchronously — poll briefly rather than asserting
    // on the exact close-event interleaving.
    const abortDeadline = Date.now() + 2_000;
    while (Date.now() < abortDeadline && provider.summaries[0]?.aborted !== true) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const held = provider.summaries[0];
    expect(held?.action).toBe("hold");
    expect(held?.aborted).toBe(true);
    release();
  });
});
