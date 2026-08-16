/**
 * pi-load-guard.ts — E2E preload hook (#1468 Gate B).
 *
 * Registered as an extra `--import` for the child-process runner. When
 * PI_LOAD_GUARD=1, ANY attempt to RESOLVE a Pi runtime module
 * (pi-core-transport, pi-stream-fn, pi-core-host, pi-runtime-contract, or the
 * @pi package) throws and fails the child. The emergency scenario must never
 * trip it: a tripped guard is direct evidence that emergency execution
 * entered a Pi boundary.
 *
 * The guard registers no hooks at all when disabled, so every other scenario
 * runs exactly as before.
 */

import { registerHooks } from "node:module";

const enabled = process.env["PI_LOAD_GUARD"] === "1";

if (enabled) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isPiRuntimeSpecifier(specifier) || (context.parentURL && isPiRuntimeSpecifier(context.parentURL))) {
        throw new Error(`pi-load-guard: refused to resolve Pi runtime module: ${specifier}`);
      }
      return nextResolve(specifier, context);
    },
  });
}

function isPiRuntimeSpecifier(specifier: string): boolean {
  // The Pi RUNTIME packages only: the in-process Pi transport host, its
  // streaming adapter, and the external @pi package. Config readers
  // (pi-executor/config.js) and the child CLI boundary are not the runtime.
  return /pi-core-transport|pi-stream-fn|pi-core-host|pi-runtime-contract|pi-tui|@pi\//.test(specifier);
}
