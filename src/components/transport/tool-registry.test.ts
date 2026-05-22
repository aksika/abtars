import { describe, it, expect } from "vitest";
import { isBridgeSpawnCommand } from "./tool-registry.js";

describe("isBridgeSpawnCommand", () => {
  it.each([
    "node current/dist/main.js --all --web --agent",
    "node /Users/akos/.abtars/current/dist/main.js",
    "nohup node dist/main.js &",
    "~/.abtars/abtars.sh --all --web",
    "bash /Users/user/.abtars/watchdog.sh --all",
    "./watchdog.sh",
    "launchctl load ~/Library/LaunchAgents/com.abtars.molty.plist",
    "launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.abtars.watchdog.plist",
    "launchctl kickstart -k gui/501/com.abtars.watchdog",
    "launchctl start com.abtars.watchdog",
  ])("blocks bridge-spawn command: %s", (cmd) => {
    expect(isBridgeSpawnCommand(cmd)).toBe(true);
  });

  it.each([
    "ls ~/.abtars/",
    "cat bridge.lock",
    "ps aux | grep node",
    "tail -f logs/bridge.log",
    "launchctl list | grep abtars",
    "launchctl unload ~/Library/LaunchAgents/com.abtars.molty.plist",
    "launchctl print gui/501/com.abtars.watchdog",
    "git log --oneline",
    "echo main is the branch",
  ])("allows safe command: %s", (cmd) => {
    expect(isBridgeSpawnCommand(cmd)).toBe(false);
  });
});
