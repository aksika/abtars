#!/usr/bin/env node
// agentbridge-restart — request bridge restart. Exits the bridge process; launchd auto-restarts.
import { writeRestartRequested } from "../components/transport/bridge-lock-transport.js";

const reason = process.argv.slice(2).join(" ") || "no reason given";
writeRestartRequested(reason);
console.log(`Restart requested: ${reason}`);
