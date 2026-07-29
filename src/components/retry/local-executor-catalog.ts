import type { ExecutorCandidate, SelectionConstraints } from "./executor-selector.js";
import { filterCandidates, selectExecutor } from "./executor-selector.js";
import type { ExecutorKind } from "../worker-supervision-store.js";

export interface ExecutorAdapterProvider {
  readonly kind: ExecutorKind;
  readonly id: string;
  getCapabilities(): readonly string[];
  isHealthy(): boolean;
  currentLoad(): number;
  availableCapacity(): number;
  supportsWorkspace(workspaceAlias: string): boolean;
  respectsSandbox(): boolean;
}

export interface LocalExecutorCatalogOptions {
  spinProvider?: ExecutorAdapterProvider;
  piProvider?: ExecutorAdapterProvider;
  piEnabled?: boolean;
  workspaceAlias?: string;
}

export class LocalExecutorCatalog {
  private readonly providers: ExecutorAdapterProvider[];

  constructor(opts: LocalExecutorCatalogOptions = {}) {
    this.providers = [];
    if (opts.spinProvider) this.providers.push(opts.spinProvider);
    if (opts.piEnabled && opts.piProvider) {
      if (opts.workspaceAlias && opts.piProvider.supportsWorkspace(opts.workspaceAlias)) {
        this.providers.push(opts.piProvider);
      }
    }
  }

  getCandidates(constraints?: SelectionConstraints): { eligible: ExecutorCandidate[]; rejected: Array<{ id: string; kind: string; reason: string }> } {
    const candidates: ExecutorCandidate[] = this.providers.map(p => ({
      id: p.id,
      kind: p.kind,
      capabilities: [...p.getCapabilities()],
      healthy: p.isHealthy(),
      load: p.currentLoad(),
    }));

    const { eligible, rejected } = filterCandidates(candidates, constraints ?? { requiredCapabilities: [] });
    return {
      eligible: eligible.map(c => ({ ...c })),
      rejected: rejected.map(r => {
        const orig = candidates.find(c => c.id === r.id);
        return { id: r.id, kind: orig?.kind ?? "unknown", reason: r.reason };
      }),
    };
  }

  select(
    constraints: SelectionConstraints,
    previousFailedIds: string[],
  ): { selected: ExecutorCandidate | null; rationale: import("./executor-selector.js").SelectionRationale } {
    const { eligible } = this.getCandidates(constraints);
    return selectExecutor(eligible, constraints, previousFailedIds);
  }

  getProvider(id: string): ExecutorAdapterProvider | undefined {
    return this.providers.find(p => p.id === id);
  }
}
