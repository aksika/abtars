#!/usr/bin/env node
// agentbridge-restart — request bridge restart. Exits the bridge process; launchd auto-restarts.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentBridgeHome } from "../paths.js";

const reason = process.argv.slice(2).join(" ") || "no reason given";
const flagFile = join(agentBridgeHome(), ".restart-requested");
writeFileSync(flagFile, `${new Date().toISOString()} ${reason}\n`);
console.log(`Restart requested: ${reason}`);
