import { describe, it, expect } from "vitest";
import { isBridgeSpawnCommand } from "./tool-registry.js";

describe("isBridgeSpawnCommand", () => {
  it.each([
    "node current/dist/main.js --all --web --agent",
    "node /Users/akos/.agentbridge/current/dist/main.js",
    "nohup node dist/main.js &",
    "~/.agentbridge/agentbridge.sh --all --web",
    "bash /Users/akos/.agentbridge/watchdog.sh --all",
    "./watchdog.sh",
    "launchctl load ~/Library/LaunchAgents/com.agentbridge.molty.plist",
    "launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.agentbridge.watchdog.plist",
    "launchctl kickstart -k gui/501/com.agentbridge.watchdog",
    "launchctl start com.agentbridge.watchdog",
  ])("blocks bridge-spawn command: %s", (cmd) => {
    expect(isBridgeSpawnCommand(cmd)).toBe(true);
  });

  it.each([
    "ls ~/.agentbridge/",
    "cat bridge.lock",
    "ps aux | grep node",
    "tail -f logs/bridge.log",
    "launchctl list | grep agentbridge",
    "launchctl unload ~/Library/LaunchAgents/com.agentbridge.molty.plist",
    "launchctl print gui/501/com.agentbridge.watchdog",
    "git log --oneline",
    "echo main is the branch",
  ])("allows safe command: %s", (cmd) => {
    expect(isBridgeSpawnCommand(cmd)).toBe(false);
  });
});
