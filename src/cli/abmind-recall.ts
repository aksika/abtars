#!/usr/bin/env node
/**
 * abmind-recall — CLI wrapper for the recall engine.
 *
 * Usage:
 *   abmind-recall --translated "kw1,kw2" --chat-id 7773842843
 *   abmind-recall --translated "puppy" --original "kiskutya" --chat-id 7773842843
 *   abmind-recall --translated "puppy" --chat-id 123 --stages Sf,Ss
 *
 * Legacy: --keywords is accepted as alias for --translated.
 */


const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    console.log(`Usage:
  abmind-recall --translated "kw1,kw2" --chat-id <id>
  abmind-recall --translated "kw" --original "kw" --chat-id <id>
  abmind-recall --translated "kw" --chat-id <id> --stages Sf,Ss
  abmind-recall --entity "Name" --chat-id <id>

Options:
  --translated <kw>       Comma-separated keywords (alias: --keywords)
  --original <kw>         Original-language keyword
  --chat-id <id>          Chat ID (required)
  --entity <name>         Entity name to search
  --stages <Sf,Ss>        Comma-separated stages to search (Sf, Ss, Se, S6)
  --limit <n>             Max results (default: 10, max: 50)
  --max-classification <n> Max classification level (default: 2)
  --time-start <epoch>    Filter by start time
  --time-end <epoch>      Filter by end time`);
    process.exit(0);
  }

  let translated: string[] = [];
  let original: string | undefined;
  let timeStart: number | undefined;
  let timeEnd: number | undefined;
  let chatId = 0;
  let limit = DEFAULT_LIMIT;
  let maxClassification = 2;
  let stages: string[] | undefined;
  let entity: string | undefined;
  let topic: string | undefined;
  let tier: "core" | "general" | undefined;
  let emotion: string | undefined;
  let includeExpired = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--translated":
      case "--keywords": // legacy alias
        translated = (args[++i] ?? "").split(",").map(k => k.trim()).filter(Boolean); break;
      case "--original": original = args[++i]; break;
      case "--time-start": timeStart = parseInt(args[++i] ?? "", 10) || undefined; break;
      case "--time-end": timeEnd = parseInt(args[++i] ?? "", 10) || undefined; break;
      case "--chat-id": chatId = parseInt(args[++i] ?? "", 10) || 0; break;
      case "--limit": limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(args[++i] ?? "", 10) || DEFAULT_LIMIT)); break;
      case "--max-classification": maxClassification = Math.min(2, Math.max(0, parseInt(args[++i] ?? "", 10))); break;
      case "--stages": stages = (args[++i] ?? "").split(",").map(s => s.trim()).filter(Boolean); break;
      case "--entity": entity = args[++i]; break;
      case "--topic": topic = args[++i]; break;
      case "--emotion": emotion = args[++i]; break;
      case "--pool": { const v = args[++i]; if (v === "core" || v === "general") tier = v; break; }
      case "--include-expired": includeExpired = true; break;
      case "--full": break; // handled below in output
    }
  }

  if ((!translated.length && !entity) || !chatId) {
    console.error('Usage: abmind-recall --translated "kw1,kw2" --chat-id <id> [--original <kw>] [--entity "Name"] [--stages S1,S3]');
    process.exit(1);
  }
  const fullMode = process.argv.includes("--full");
  return { translated, original, timeStart, timeEnd, chatId, limit, maxClassification, stages, entity, topic, tier, emotion, includeExpired, resolution: fullMode ? "full" as const : undefined };
}

const params = parseArgs();

const config = (await import("abmind/memory-config.js")).loadMemoryConfig();
const { createMemoryBackend } = await import("abmind/backend-factory.js");
const backend = await createMemoryBackend(config);

try {
  const result = await backend.recall({
    translated: params.translated,
    original: params.original,
    chatId: params.chatId,
    limit: params.limit,
    maxClassification: params.maxClassification,
    timeStart: params.timeStart,
    timeEnd: params.timeEnd,
    stages: params.stages,
    entity: params.entity,
    topic: params.topic,
    tier: params.tier,
    includeExpired: params.includeExpired,
    resolution: params.resolution,
  });

  // JSON output to stdout
  console.log(JSON.stringify(result.results, null, 2));

  // Hit-rate summary to stderr
  const stageSummary = Object.entries(result.stages).map(([k, v]) => `${k}=${v.hits.length}`).join(" ");
  const query = params.translated.join(" ");
  console.error(`[recall] query="${query}" ${stageSummary} short_circuit=${result.shortCircuitAfter ?? "none"} total=${result.results.length}`);

  // Expand hint
  const expandable = result.results.filter(r => r.source_ids);
  if (expandable.length) {
    const allIds = expandable.map(r => r.source_ids).join(",");
    console.error(`\nHint: ${expandable.length} result(s) have source message IDs. Expand with:\n  abmind-expand --ids ${allIds}`);
  }
} finally {
  backend.close();
}
