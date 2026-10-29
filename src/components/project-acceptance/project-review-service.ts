import { ProjectReviewStore } from "./project-review-store.js";
import type { ProjectReviewDecisionV1 } from "./project-review-validator.js";
import type { ReviewCaseSnapshot } from "./project-review-case.js";

// #1792: the decision/settle path (ProjectReviewService.processDecision +
// repair-source validation) is deleted with the supervised review-turn world —
// the runner judges via submitVerdict and settles through the store directly.
// What remains is the acceptance-outbox drain (heartbeat-tier3) and the pure
// delivered-synthesis renderer.

export async function drainAcceptanceOutbox(): Promise<number> {
  const store = new ProjectReviewStore();
  const pending = store.getPendingAcceptanceOutbox();
  if (pending.length === 0) return 0;
  const { getPeerWsBroker } = await import("../peer-transport/peer-ws-broker.js");
  const broker = getPeerWsBroker();
  if (!broker) return 0;
  let sent = 0;
  for (const row of pending) {
    try {
      // #1680: transport request resolution is NOT delivery success. Only the
      // requester's literal `{ ok: true }` application ACK authorizes `sent_at`.
      // A negative, malformed, or timed-out response keeps the row pending.
      const ack = await broker.sendRequest<unknown>(row.peer, "help.event.v1", JSON.parse(row.payload_json));
      const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
      if (!isRecord(ack) || ack.ok !== true) {
        throw new Error("help_event_not_applied");
      }
      if (store.markAcceptanceOutboxSent(row.id)) sent++;
    } catch (err) {
      store.markAcceptanceOutboxAttempt(row.id, err instanceof Error ? err.message : String(err));
    }
  }
  return sent;
}

/** #1605: cap for the rendered synthesis (card result summary limit is 4000). */
export const RENDERED_SYNTHESIS_MAX = 4000;
const RENDERED_RATIONALE_MAX = 500;

/**
 * #1605: pure renderer for the delivered synthesis. Returns the authored
 * synthesis unchanged when there are no accepted optional gaps; otherwise
 * appends a canonical, bounded "Known gaps" section in root-contract order so
 * the Orc's declared omissions reach the user deterministically.
 */
export function renderAcceptedSynthesis(
  decision: ProjectReviewDecisionV1,
  caseSnapshot: ReviewCaseSnapshot,
): string {
  const policyByCriterionId = new Map(caseSnapshot.criterion_inputs.map(ci => [ci.criterion_id, ci]));
  const gaps = decision.criteria
    .filter(c => {
      const policy = policyByCriterionId.get(c.criterion_id);
      if (!policy) return false;
      return !policy.required && (c.verdict === "unsatisfied" || c.verdict === "inconclusive");
    })
    .map(c => ({ id: c.criterion_id, verdict: c.verdict, rationale: c.rationale }));
  if (gaps.length === 0) return decision.synthesis;

  const order = new Map(caseSnapshot.root_contract.criteria.map((c, i) => [c.id, i]));
  const ordered = [...gaps].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const sectionPrefix = "\n\nKnown gaps:\n";
  const linePrefixes = ordered.map(g => `- ${g.id}: ${g.verdict} — `);
  const fixedSectionLength = sectionPrefix.length + linePrefixes.join("\n").length;

  // Reserve the bounded result for the complete gap list first. When many
  // optional gaps exist, ration the rationale budget across them rather than
  // truncating the finished section and silently dropping later gap IDs.
  let rationaleBudget = Math.max(0, RENDERED_SYNTHESIS_MAX - fixedSectionLength);
  const lines = ordered.map((g, index) => {
    const remainingGaps = ordered.length - index;
    const allowance = Math.min(RENDERED_RATIONALE_MAX, Math.floor(rationaleBudget / remainingGaps));
    const rationale = g.rationale.slice(0, allowance);
    rationaleBudget -= rationale.length;
    return linePrefixes[index] + rationale;
  });
  const section = sectionPrefix + lines.join("\n");

  // #1605: reserve space for the disclosure so a long authored synthesis can
  // never silently drop the Known gaps section or any normally-sized gap ID.
  // Extremely long criterion IDs can exceed the payload cap by themselves;
  // retain the hard result bound even for that malformed-but-stored case.
  const boundedSection = section.slice(0, RENDERED_SYNTHESIS_MAX);
  const maxBase = Math.max(0, RENDERED_SYNTHESIS_MAX - boundedSection.length);
  return decision.synthesis.slice(0, maxBase) + boundedSection;
}
