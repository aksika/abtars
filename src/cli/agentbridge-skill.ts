#!/usr/bin/env node
/**
 * agentbridge-skill — CLI for agent-managed skill files.
 *
 * Create:
 *   agentbridge-skill --action create --name "git-rebase" --content "# Git Rebase\n..."
 *
 * Edit (full replace):
 *   agentbridge-skill --action edit --name "git-rebase" --content "# Git Rebase v2\n..."
 *
 * Patch (append):
 *   agentbridge-skill --action patch --name "git-rebase" --content "\n## New Section\n..."
 *
 * Delete:
 *   agentbridge-skill --action delete --name "git-rebase"
 *
 * List:
 *   agentbridge-skill --action list
 *
 * Output: { "ok": true, "action": "create", "path": "~/.agentbridge/skills/auto/git-rebase.md" }
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentBridgeHome } from "../paths.js";

interface Args {
  action: string;
  name?: string;
  content?: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const m = args[i]!.match(/^--(\w[\w-]*)$/);
    if (m && i + 1 < args.length) result[m[1]!] = args[++i]!;
  }
  return { action: result["action"] ?? "", name: result["name"], content: result["content"] };
}

function out(data: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function sanitizeName(name: string): string {
  return name.replace(/\.md$/, "").replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}

async function main(): Promise<void> {
  const args = parseArgs();
  const autoDir = join(agentBridgeHome(), "skills", "auto");
  mkdirSync(autoDir, { recursive: true });

  if (args.action === "list") {
    const files = existsSync(autoDir)
      ? readdirSync(autoDir).filter(f => f.endsWith(".md")).map(f => f.replace(/\.md$/, "")).sort()
      : [];
    out({ ok: true, action: "list", skills: files, count: files.length });
    return;
  }

  if (!args.name) { out({ ok: false, error: "missing --name" }); process.exit(1); }
  const name = sanitizeName(args.name);
  const path = join(autoDir, `${name}.md`);

  if (args.action === "delete") {
    if (!existsSync(path)) { out({ ok: false, error: `skill not found: ${name}` }); process.exit(1); }
    unlinkSync(path);
    out({ ok: true, action: "delete", name });
    return;
  }

  if (!args.content) { out({ ok: false, error: "missing --content" }); process.exit(1); }

  // Security scan
  const { scanPrompt } = await import("../components/prompt-scanner.js");
  const hit = scanPrompt(args.content);
  if (hit) {
    out({ ok: false, error: `security scan blocked: ${hit.patternId}`, matched: hit.matched });
    process.exit(1);
  }

  if (args.action === "create") {
    if (existsSync(path)) { out({ ok: false, error: `skill already exists: ${name}. Use --action edit to update.` }); process.exit(1); }
    writeFileSync(path, args.content, "utf-8");
    out({ ok: true, action: "create", name, path });
  } else if (args.action === "edit") {
    if (!existsSync(path)) { out({ ok: false, error: `skill not found: ${name}. Use --action create.` }); process.exit(1); }
    writeFileSync(path, args.content, "utf-8");
    out({ ok: true, action: "edit", name, path });
  } else if (args.action === "patch") {
    if (!existsSync(path)) { out({ ok: false, error: `skill not found: ${name}. Use --action create.` }); process.exit(1); }
    const existing = readFileSync(path, "utf-8");
    writeFileSync(path, existing + args.content, "utf-8");
    out({ ok: true, action: "patch", name, path });
  } else {
    out({ ok: false, error: `unknown action: ${args.action}. Use create|edit|patch|delete|list.` });
    process.exit(1);
  }
}

main().catch(err => {
  out({ ok: false, error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
