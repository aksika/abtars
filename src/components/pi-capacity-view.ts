/**
 * pi-capacity-view.ts — #1638: advisory Pi capacity surface for check_workers.
 *
 * Sourced from the live Pi service (when registered) and pi_workspace_claims.
 * Maps canonical claim paths back to configured alias names for display
 * (deduped, sorted), never exposing raw canonical paths. Advisory only — all
 * admission invariants remain transactionally enforced.
 */
import type { PiRunService } from "./pi-executor/pi-run-service.js";

let _piService: PiRunService | null = null;

export function setPiCapacityService(service: PiRunService | null): void {
  _piService = service;
}

export interface PiCapacityView {
  enabled: boolean;
  healthy: boolean;
  active: number;
  max: number;
  free: number;
  busyAliases: string[];
}

export function getPiCapacityView(): PiCapacityView {
  const svc = _piService;
  if (!svc) {
    return { enabled: false, healthy: false, active: 0, max: 0, free: 0, busyAliases: [] };
  }
  let healthy = true;
  let active = svc.executor.activeCount;
  let max = svc.executor.maxConcurrent;
  try {
    active = svc.executor.activeCount;
    max = svc.executor.maxConcurrent;
  } catch {
    healthy = false;
    active = 0;
    max = 0;
  }
  const free = Math.max(0, max - active);

  const busyAliases = new Set<string>();
  try {
    const claims = svc.store.listWorkspaceClaims();
    const byCanonical = new Map<string, string[]>();
    for (const alias of Object.keys(svc.config.workspaceAliases)) {
      const target = svc.config.workspaceAliases[alias]?.path ?? "";
      byCanonical.set(target, [...(byCanonical.get(target) ?? []), alias]);
    }
    for (const claim of claims) {
      for (const [target, aliases] of byCanonical) {
        if (target === claim.canonicalPath) {
          for (const a of aliases) busyAliases.add(a);
        }
      }
    }
  } catch { /* claims unreadable — empty busy set */ }

  return { enabled: true, healthy, active, max, free, busyAliases: [...busyAliases] };
}
