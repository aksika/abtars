import { WorkerSupervisionStore } from "./worker-supervision-store.js";
import { normalizeContract, createContractId, createAttemptId } from "./worker-contract.js";
import type { WorkerAcceptanceContractV1 } from "./worker-contract.js";
import type { TaskDatabase } from "./tasks/kanban-board.js";

export class WorkerSupervisionService {
  private store: WorkerSupervisionStore;

  constructor(db?: TaskDatabase) {
    this.store = new WorkerSupervisionStore(db);
  }

  createChild(
    rawGoal: string,
    cardId: number,
    rootCardId: number,
    authoredBy: string,
    opts?: {
      criteria?: Array<{ id: string; description: string }>;
      expectedArtifacts?: Array<{ id: string; kind: "file" | "directory" | "report" | "logical"; ref: string; required: boolean; criterion_ids: string[] }>;
      verificationCommands?: Array<{ id: string; argv: string[]; cwd?: string; timeout_ms: number; criterion_ids: string[] }>;
      requiredCapabilities?: string[];
      limits?: { max_duration_ms?: number; max_tokens?: number };
      contractId?: string;
      attemptId?: string;
    },
  ): { contract: WorkerAcceptanceContractV1; attemptId: string } | { error: string } {
    if (this.store.contractExists(cardId)) {
      return { error: `card #${cardId} already has a contract` };
    }

    const contractId = opts?.contractId ?? createContractId();
    const raw: Record<string, unknown> = {
      schema_version: 1,
      id: contractId,
      goal: rawGoal,
      criteria: opts?.criteria ?? [{ id: "c1", description: rawGoal }],
      provenance: {
        root_card_id: rootCardId,
        card_id: cardId,
        authored_by: authoredBy,
        created_at: new Date().toISOString(),
      },
    };
    if (opts?.expectedArtifacts && opts.expectedArtifacts.length > 0) {
      raw["expected_artifacts"] = opts.expectedArtifacts;
    }
    if (opts?.verificationCommands && opts.verificationCommands.length > 0) {
      raw["verification_commands"] = opts.verificationCommands;
    }
    if (opts?.requiredCapabilities && opts.requiredCapabilities.length > 0) {
      raw["required_capabilities"] = opts.requiredCapabilities;
    }
    if (opts?.limits && Object.keys(opts.limits).length > 0) {
      raw["limits"] = opts.limits;
    }

    const normalized = normalizeContract(raw);
    if (!normalized.ok) {
      return { error: `contract validation failed: ${normalized.errors.map(e => e.message).join("; ")}` };
    }

    this.store.insertContract(normalized.contract, cardId);

    const attemptId = opts?.attemptId ?? createAttemptId();
    this.store.insertAttempt({
      id: attemptId,
      card_id: cardId,
      contract_id: normalized.contract.id,
      ordinal: this.store.nextOrdinal(cardId),
      executor_kind: "local_worker",
      executor_id: "spin",
      status: "pending",
      started_at: new Date().toISOString(),
    });

    return { contract: normalized.contract, attemptId };
  }

  getContractForCard(cardId: number): WorkerAcceptanceContractV1 | undefined {
    const row = this.store.getContractByCardId(cardId);
    if (!row) return undefined;
    return JSON.parse(row.contract_json) as WorkerAcceptanceContractV1;
  }

  cardHasContract(cardId: number): boolean {
    return this.store.contractExists(cardId);
  }

  renderContractForPrompt(contract: WorkerAcceptanceContractV1): string {
    const lines: string[] = [];

    lines.push(`<worker-contract id="${contract.id}" digest="${contract.digest}">`);
    lines.push(`  <goal>${contract.goal}</goal>`);

    if (contract.criteria.length > 0) {
      lines.push("  <criteria>");
      for (const c of contract.criteria) {
        lines.push(`    <criterion id="${c.id}">${c.description}</criterion>`);
      }
      lines.push("  </criteria>");
    }

    if (contract.expected_artifacts.length > 0) {
      lines.push("  <expected-artifacts>");
      for (const a of contract.expected_artifacts) {
        lines.push(`    <artifact id="${a.id}" kind="${a.kind}" required="${a.required}">${a.ref}</artifact>`);
      }
      lines.push("  </expected-artifacts>");
    }

    if (contract.verification_commands.length > 0) {
      lines.push("  <verification-commands>");
      for (const cmd of contract.verification_commands) {
        lines.push(`    <command id="${cmd.id}">${cmd.argv.join(" ")}</command>`);
      }
      lines.push("  </verification-commands>");
    }

    if (contract.required_capabilities.length > 0) {
      lines.push(`  <required-capabilities>${contract.required_capabilities.join(", ")}</required-capabilities>`);
    }

    lines.push("</worker-contract>");
    return lines.join("\n");
  }
}
