import { loadMemoryConfig } from "../src/components/memory-config.js";
import { MemoryManager } from "../src/components/memory-manager.js";

async function main() {
  const config = loadMemoryConfig();
  const mm = new MemoryManager(config);
  await mm.initialize();

  // Test substring search directly
  console.log("\n=== Direct substringSearch: 'mi a jelszo?' ===");
  const subResults = mm.substringSearch("mi a jelszo?", { chatId: 7773842843, limit: 10 });
  for (const r of subResults) {
    console.log(`  [${r.record.role}] score=${r.score.toFixed(3)} "${r.record.content.slice(0, 80)}"`);
  }

  const queries = [
    "mi a jelszo?",
    "kiskutya fasza hany centi?",
    "mi a jelszo? kiskutya fasza hany centi?",
    "emlekezz, mi volt a jelszo es hany centis a kiskutya fasza",
  ];

  for (const q of queries) {
    console.log(`\n=== assembleContext: '${q}' ===`);
    const ctx = await mm.assembleContext({
      chatId: 7773842843,
      userInput: q,
      systemPrompt: "",
    });
    const recalledMatch = ctx.match(/\[RECALLED MEMORIES\][\s\S]*?(?=\n\n\[|$)/);
    if (recalledMatch) {
      console.log(recalledMatch[0]);
    } else {
      console.log("(no recalled memories)");
    }
    console.log("---");
  }

  mm.close();
}

main().catch(console.error);
