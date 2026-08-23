/**
 * sha-admission-notice.ts — #1688 R9: builds the bounded SHA admission outcome
 * line. Pure formatting; platform delivery stays with the source adapters.
 * Exactly one notice per durable admission decision; duplicate event keys
 * produce none.
 */
import type { ShaAdmissionOutcome, ShaFailureSignal } from "./sha-types.js";

export function shaAdmissionNotice(_signal: ShaFailureSignal, outcome: ShaAdmissionOutcome): string | null {
  switch (outcome.kind) {
    case "ignored":
      // #1708: anomaly cooldown is a silent ignore — no second operator
      // message for an episode that was already admitted or suppressed.
      if (outcome.reason === "cooldown") return null;
      if (outcome.reason === "off") return "SHA: off — no self-healing action.";
      if (outcome.reason === "system") return "SHA: system-kind failure — outside SHA remediation authority (notified only).";
      if (outcome.reason === "credits") return "SHA: provider credits exhausted — not self-healable.";
      if (outcome.reason === "external") return "SHA: external/authorization outage — not self-healable.";
      if (outcome.reason === "ambiguous") return "SHA: ambiguous failure — not self-healable.";
      return "SHA: suppressed by policy.";
    case "duplicate_event":
      return null;
    case "attached":
      return `SHA: attached to incident #${outcome.incidentId} (occurrence ${outcome.occurrenceCount}, root card #${outcome.rootCardId}).`;
    case "project_created":
      return `SHA: incident #${outcome.incidentId} opened — root card #${outcome.rootCardId} (mode ${outcome.mode}). RCA worker started.`;
    case "known_fix_started":
      return `SHA: known fix started (incident #${outcome.incidentId}).`;
    case "known_fix_recommended":
      return "SHA: wired fix available — recommendation only (enable full mode with a verified rule and verifier).";
    case "blocked":
      return `SHA: admission blocked — ${outcome.reason.slice(0, 300)}.`;
  }
}