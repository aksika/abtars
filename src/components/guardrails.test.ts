import { describe, expect, it } from "vitest";
import { classifyCommand } from "./guardrails.js";

describe("guardrails command classification", () => {
  it.each([
    ["daily-summary heredoc prose", "cat > /tmp/summary <<'EOF'\nRetrospective mentions sudo, DROP TABLE, and rm -rf / as history.\nEOF", "allow"],
    ["quoted non-executable data", `echo "history: bash -c 'sudo rm -rf /'"`, "allow"],
    ["single-quoted substitution data", `echo '$(sudo id)'`, "allow"],
    ["nested safe shell", `bash -c 'echo "ordinary text"'`, "allow"],
    ["nested dangerous shell", "time -p bash -c 'sudo id'", "auth-required"],
    ["timeout wrapper cannot hide destructive command", "timeout 10 rm -rf /tmp/test", "auth-required"],
    ["nice wrapper cannot hide destructive command", "nice -n 10 rm -rf /tmp/test", "auth-required"],
    ["taskset cpu-list wrapper cannot hide destructive command", "taskset --cpu-list 0 rm -rf /", "block"],
    ["taskset pid wrapper cannot hide destructive command", "taskset -p 1234 rm -rf /", "block"],
    ["busybox applet cannot hide destructive command", "busybox rm -rf /", "block"],
    ["env split-string cannot hide a command", `env -S "sudo rm -rf /"`, "auth-required"],
    ["chained source", "true; source /tmp/credentials.sh", "auth-required"],
    ["relative script execution", "./maintenance.sh", "auth-required"],
    ["absolute script execution", "/tmp/maintenance.sh", "auth-required"],
    ["absolute safe binary", "/bin/cat /tmp/summary", "allow"],
    ["safe SQL heredoc", "sqlite3 db <<'EOF'\nSELECT 1;\nEOF", "allow"],
    ["safe SQL here-string", `sqlite3 db <<< "SELECT 1"`, "allow"],
    ["destructive SQL heredoc", "sqlite3 db <<EOF\nDROP TABLE accounts;\nEOF", "auth-required"],
    ["destructive SQL here-string", `sqlite3 db <<< "DROP TABLE accounts"`, "auth-required"],
    ["destructive SQL quoted table", `sqlite3 db <<< "DELETE FROM \\\"accounts\\\""`, "auth-required"],
    ["SQL shell meta-command", "sqlite3 db <<'EOF'\n.shell rm -rf /tmp/test\nEOF", "auth-required"],
    ["dynamic SQL input", 'sqlite3 db "$SQL"', "auth-required"],
    ["SQL external file option", "sqlite3 db --file=queries.sql", "auth-required"],
    ["git option before destructive subcommand", "git -C repo reset --hard", "auth-required"],
    ["fd redirect does not hide following executable", "2>&1 sudo id", "auth-required"],
    ["dynamic rm target fails closed", `rm -rf "$TARGET"`, "auth-required"],
    ["dynamic git options fail closed", "git $GIT_ARGS", "auth-required"],
    ["ambiguous shell syntax", "echo 'unterminated", "auth-required"],
  ] as const)("classifies %s from executable structure", (_name, command, expected) => {
    expect(classifyCommand(command)).toBe(expected);
  });
});
