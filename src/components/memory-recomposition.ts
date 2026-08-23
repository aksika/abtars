/**
 * memory-recomposition — stable re-composable memory runtime facade (#1706).
 *
 * When the boot-time memory negotiation fails, consumers still capture a
 * single `AbtarsMemoryRuntime` reference for the whole bridge generation.
 * This facade keeps that reference stable while a supervisor retries the
 * composition behind it: every property getter, method, and nested
 * `dreamQuestions` call resolves the current delegate at call time, so an
 * upgrade flips `state` to `"ready"` for every existing holder without any
 * consumer change.
 *
 * Owns no timers and no endpoint knowledge — the supervisor
 * (`MemoryRecompositionSupervisor`, same module) drives retries and calls
 * `upgrade()` exactly once through its publication callback.
 */

import {
  createUnavailableRuntime,
  type AbtarsMemoryRuntime,
  type MemoryCompositionDiagnostics,
} from "./memory-runtime.js";
import { logWarn } from "./logger.js";

const TAG = "memory-recomposition";

/** Owner-facing control surface. Consumers only ever see `.runtime`. */
export interface RecomposableMemoryRuntimeController {
  readonly runtime: AbtarsMemoryRuntime;
  /** Install the negotiated delegate. Returns false (and closes nothing) when
   *  the facade was already upgraded; the caller must dispose the rejected
   *  runtime. */
  upgrade(runtime: AbtarsMemoryRuntime): boolean;
  /** Replace the bounded diagnostics snapshot (immutable copies kept). */
  setDiagnostics(snapshot: MemoryCompositionDiagnostics): void;
}

export class RecomposableMemoryRuntime implements RecomposableMemoryRuntimeController {
  readonly runtime: AbtarsMemoryRuntime;

  private inner: AbtarsMemoryRuntime;
  private upgraded = false;
  private closed = false;
  private rejectedSecondUpgradeLogged = false;
  private diagnostics: MemoryCompositionDiagnostics = { state: "idle", attempts: 0 };

  constructor(initial: AbtarsMemoryRuntime = createUnavailableRuntime()) {
    this.inner = initial;
    const resolve = (): AbtarsMemoryRuntime => this.inner;
    const self = this;

    this.runtime = {
      get state() { return resolve().state; },
      get capabilities() { return resolve().capabilities; },
      get routeSnapshot() { return resolve().routeSnapshot; },
      get compositionDiagnostics() { return { ...self.diagnostics }; },

      supports: (...args) => resolve().supports(...args),
      recordMessage: (input, operationKey) => resolve().recordMessage(input, operationKey),
      recall: (input) => resolve().recall(input),
      assembleSessionContext: (input) => resolve().assembleSessionContext(input),
      getRecentConversation: (input) => resolve().getRecentConversation(input),
      getStatus: (input) => resolve().getStatus(input),
      getSleepStatus: () => resolve().getSleepStatus(),
      getCoreKnowledge: (input) => resolve().getCoreKnowledge(input),
      recordFeedback: (input, operationKey) => resolve().recordFeedback(input, operationKey),
      embed: (input) => resolve().embed(input),
      runMaintenance: (input) => resolve().runMaintenance(input),
      instantStore: (input) => resolve().instantStore(input),
      editMemory: (input) => resolve().editMemory(input),
      rebuildFtsIndexes: () => resolve().rebuildFtsIndexes(),
      projectDurableContext: (input) => resolve().projectDurableContext(input),
      prepareConversationCompaction: (input) => resolve().prepareConversationCompaction(input),
      commitConversationCompaction: (input, operationKey) => resolve().commitConversationCompaction(input, operationKey),

      // Stable nested object: a consumer that captures `facade.dreamQuestions`
      // before the upgrade must not retain the unavailable delegate.
      dreamQuestions: {
        nextPending: (...args) => resolve().dreamQuestions.nextPending(...args),
        list: (...args) => resolve().dreamQuestions.list(...args),
        markAsked: (...args) => resolve().dreamQuestions.markAsked(...args),
        dismiss: (...args) => resolve().dreamQuestions.dismiss(...args),
      },

      findSealedSecrets: (input) => resolve().findSealedSecrets(input),
      resolveSealedSecret: (input) => resolve().resolveSealedSecret(input),

      close: async () => {
        if (self.closed) return;
        self.closed = true;
        await resolve().close();
      },
    };
  }

  upgrade(runtime: AbtarsMemoryRuntime): boolean {
    if (this.upgraded) {
      if (!this.rejectedSecondUpgradeLogged) {
        this.rejectedSecondUpgradeLogged = true;
        logWarn(TAG, "upgrade rejected: memory runtime already composed");
      }
      return false;
    }
    this.upgraded = true;
    this.inner = runtime;
    return true;
  }

  setDiagnostics(snapshot: MemoryCompositionDiagnostics): void {
    this.diagnostics = { ...snapshot };
  }
}
