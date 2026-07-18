import { join } from "node:path";
import type { SoulInput } from "../cli/commands/doctor-types.js";

export function describeSoulInputs(input: {
  memoryMode: "available" | "unavailable";
  abtarsHome: string;
  abtarsRoot: string;
  abmindHome: string;
}): SoulInput[] {
  const abmindPersona = join(input.abmindHome, "memory", "core");
  // orc.md/worker.md are seeded from templates/prompts/ into the runtime
  // home's prompts/ dir at deploy time (see reconcile.ts) — abtarsRoot()
  // (the release/code dir) never has a bare prompts/ directory.
  const orcPromptPath = join(input.abtarsHome, "prompts", "orc.md");
  const workerPromptPath = join(input.abtarsHome, "prompts", "worker.md");

  if (input.memoryMode === "available") {
    return [
      { id: "main.soul", path: join(abmindPersona, "SOUL.md"), required: true },
      { id: "main.profile", path: join(abmindPersona, "user_profile.md"), required: true },
      { id: "main.notes", path: join(abmindPersona, "agent_notes.md"), required: true },
      { id: "main.memory-tools", path: join(abmindPersona, "memory-tools.md"), required: true },
      { id: "main.core-facts", path: join(abmindPersona, "core_facts.md"), required: true },
      { id: "main.minimal-fallback", path: join(input.abtarsHome, "prompts", "default-minimal.md"), required: false },
      { id: "orc.prompt", path: orcPromptPath, required: true },
      { id: "worker.prompt", path: workerPromptPath, required: true },
    ];
  }

  return [
    { id: "main.minimal-fallback", path: join(input.abtarsHome, "prompts", "default-minimal.md"), required: true },
    { id: "orc.prompt", path: orcPromptPath, required: true },
    { id: "worker.prompt", path: workerPromptPath, required: true },
  ];
}
