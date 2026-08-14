#!/usr/bin/env tsx
/**
 * abmind local E2E consumer probe — exercises abtars' real createClientRuntime
 * against a live abmind daemon over its Unix socket.
 *
 * Owns no daemon lifecycle. Emits ABTARS_ABMIND_E2E_RESULT=<json> on stdout.
 * Expected args: --socket <path> --run-id <id>
 */
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { AbmindClient, LocalTransport } from "../../abmind/dist/src/index.js";
import { createClientRuntime } from "../src/components/memory-runtime.js";
import { runProjectionJourney } from "./probe-projection-journey.js";

interface ProbeResult {
  ok: boolean;
  failures: string[];
}

async function main(): Promise<ProbeResult> {
  const args = parseArgs({
    options: {
      socket: { type: "string", required: true },
      "run-id": { type: "string", required: true },
    },
  });

  const socketPath = args.values.socket;
  const runId = args.values["run-id"];
  const user = process.env.ABMIND_E2E_DISPOSABLE_USER;
  const failures: string[] = [];

  if (!socketPath || !existsSync(socketPath)) {
    failures.push(`socket path does not exist: ${socketPath}`);
    return { ok: false, failures };
  }

  if (!runId) {
    failures.push("run-id is required");
    return { ok: false, failures };
  }
  if (!user || !/^e2e[-_]/.test(user)) {
    failures.push("ABMIND_E2E_DISPOSABLE_USER must be an explicit e2e-* user");
    return { ok: false, failures };
  }

  const transport = new LocalTransport(socketPath);
  const client = new AbmindClient(transport);
  try {
    await client.negotiate();

    const runtime = createClientRuntime(client);

    if (runtime.state !== "ready") {
      failures.push(`runtime state is ${runtime.state}, expected "ready"`);
    }

    if (!runtime.supports("instantStore") || !runtime.supports("recall") || !runtime.supports("editMemory")) {
      failures.push(`missing capabilities: store=${runtime.supports("instantStore")} recall=${runtime.supports("recall")} edit=${runtime.supports("editMemory")}`);
    }

    const storeResult = await runtime.instantStore({
      userId: user,
      contentEn: "Probe store test",
      contentOriginal: "Probe store test",
      memoryType: "fact",
      emotionScore: 0.5,
      confidence: 5,
      classification: 1,
    });
    if (!storeResult.stored) {
      failures.push(`instantStore failed: ${JSON.stringify(storeResult)}`);
    }

    if (storeResult.stored) {
      const memoryId = storeResult.memoryId;
      const revision = storeResult.semanticRevision;
      const editResult = await runtime.editMemory({
        memoryId,
        expectedRevision: revision,
        userId: user,
        contentEn: "Probe edit test",
      });
      if (!editResult.ok) {
        failures.push(`editMemory failed: ${JSON.stringify(editResult)}`);
      }

      const staleEditResult = await runtime.editMemory({
        memoryId,
        expectedRevision: revision,
        userId: user,
        contentEn: "Stale probe edit",
      });
      if (editResult.ok && (staleEditResult.ok || staleEditResult.code !== "memory_conflict")) {
        failures.push(`stale edit should have produced a conflict: ${JSON.stringify(staleEditResult)}`);
      }
    }

    const recallResult = await runtime.recall({
      query: "probe",
      userId: user,
      limit: 5,
    });
    if (!recallResult.hits || recallResult.hits.length === 0) {
      failures.push("recall returned no hits after store");
    }

    // #1527: escaped-regression journey — durable projection through the real
    // runtime + real Pi projection against the live daemon.
    await runProjectionJourney(runtime, user, runId, failures);

    const result: ProbeResult = { ok: failures.length === 0, failures };
    return result;
  } finally {
    await client.close();
  }
}

const result = await main();
console.log(`ABTARS_ABMIND_E2E_RESULT=${JSON.stringify(result)}`);
if (!result.ok) {
  process.stderr.write(`Probe failures:\n${result.failures.map(f => `  - ${f}`).join("\n")}\n`);
  process.exit(1);
}
