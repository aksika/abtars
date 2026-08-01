#!/usr/bin/env tsx
/**
 * abmind remote E2E consumer probe — exercises abtars' production #1508
 * endpoint selector and memory-runtime factory against a live abmind
 * daemon over signed WSS, in an environment where a runtime abmind
 * package cannot be resolved.
 *
 * Owns no daemon lifecycle. Emits ABTARS_ABMIND_E2E_RESULT=<json> on stdout.
 * Expected args: --home <abtars home with config/abmind.json> --run-id <id>
 */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { resolveAbmindEndpoint } from "../src/components/abmind-endpoint-config.js";
import { createMemoryRuntimeFromEndpoint } from "../src/boot/phase-memory.js";
import { resolveAbmindPackageDir } from "../src/utils/abmind-lazy.js";
import { runProjectionJourney } from "./probe-projection-journey.js";

interface ProbeResult {
  ok: boolean;
  failures: string[];
}

async function main(): Promise<ProbeResult> {
  const args = parseArgs({
    options: {
      home: { type: "string", required: true },
      "run-id": { type: "string", required: true },
    },
  });

  const home = args.values.home;
  const runId = args.values["run-id"];
  const user = process.env.ABMIND_E2E_DISPOSABLE_USER;
  const failures: string[] = [];

  if (!runId) {
    failures.push("run-id is required");
    return { ok: false, failures };
  }
  if (!user || !/^e2e[-_]/.test(user)) {
    failures.push("ABMIND_E2E_DISPOSABLE_USER must be an explicit e2e-* user");
    return { ok: false, failures };
  }

  const configDir = join(home, "config");
  if (!existsSync(join(configDir, "abmind.json"))) {
    failures.push(`abmind.json not found under ${configDir}`);
    return { ok: false, failures };
  }

  // Prove the environment has no resolvable runtime abmind package: if the
  // WSS route accidentally invoked local package discovery it would have to
  // work without one.
  if (resolveAbmindPackageDir() !== null) {
    failures.push("runtime abmind package resolved in probe environment — remote route must not depend on it");
  }

  let endpoint;
  try {
    endpoint = resolveAbmindEndpoint(configDir);
  } catch (err) {
    failures.push(`endpoint resolution failed: ${(err as Error).message}`);
    return { ok: false, failures };
  }

  if (endpoint.mode !== "wss") {
    failures.push(`expected wss endpoint, got mode=${endpoint.mode}`);
    return { ok: false, failures };
  }

  try {
    const result = await createMemoryRuntimeFromEndpoint(endpoint, home);

    if (result.mode !== "wss") {
      failures.push(`factory returned mode=${result.mode}, expected wss`);
    }
    if (result.abmindModule !== null) {
      failures.push("abmindModule must stay null for the WSS route");
    }
    if (result.runtime.state !== "ready") {
      failures.push(`runtime state is ${result.runtime.state}, expected "ready"`);
    }

    if (!result.runtime.supports("instantStore") || !result.runtime.supports("recall") || !result.runtime.supports("editMemory")) {
      failures.push("missing capabilities: " +
        `store=${result.runtime.supports("instantStore")} recall=${result.runtime.supports("recall")} edit=${result.runtime.supports("editMemory")}`);
    }

    const storeToken = `${runId}-probe-store`;
    const storeResult = await result.runtime.instantStore({
      userId: user,
      contentEn: "Remote probe store test",
      contentOriginal: "Remote probe store test",
      memoryType: "fact",
      emotionScore: 0.5,
      confidence: 5,
      classification: 1,
    }, storeToken);
    if (!storeResult.stored || !storeResult.memoryId || !storeResult.semanticRevision) {
      failures.push(`instantStore failed: ${JSON.stringify(storeResult)}`);
    }

    if (storeResult.semanticRevision) {
      const editResult = await result.runtime.editMemory({
        memoryId: storeResult.memoryId!,
        expectedRevision: storeResult.semanticRevision,
        userId: user,
        contentEn: "Remote probe edit test",
      });
      if (!editResult.ok) {
        failures.push(`editMemory failed: ${JSON.stringify(editResult)}`);
      }

      const staleEditResult = await result.runtime.editMemory({
        memoryId: storeResult.memoryId!,
        expectedRevision: storeResult.semanticRevision,
        userId: user,
        contentEn: "Stale remote probe edit",
      });
      if (editResult.ok && (staleEditResult.ok || staleEditResult.error !== "conflict")) {
        failures.push(`stale edit should have produced a conflict: ${JSON.stringify(staleEditResult)}`);
      }
    }

    const recallResult = await result.runtime.recall({
      query: "probe",
      userId: user,
      limit: 5,
    });
    if (!recallResult.hits || recallResult.hits.length === 0) {
      failures.push("recall returned no hits after store");
    }

    // #1527: escaped-regression journey — durable projection through the real
    // WSS runtime + real Pi projection against the live daemon.
    await runProjectionJourney(result.runtime, user, runId, failures);

    await result.runtime.close();

    const probeResult: ProbeResult = { ok: failures.length === 0, failures };
    return probeResult;
  } catch (err) {
    failures.push(`runtime journey failed: ${(err as Error).message}`);
    return { ok: false, failures };
  }
}

const result = await main();
console.log(`ABTARS_ABMIND_E2E_RESULT=${JSON.stringify(result)}`);
if (!result.ok) {
  process.stderr.write(`Probe failures:\n${result.failures.map(f => `  - ${f}`).join("\n")}\n`);
  process.exit(1);
}
