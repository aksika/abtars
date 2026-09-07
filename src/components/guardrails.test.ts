import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCommand, isRootScopeAllow } from "./guardrails.js";

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

// ── #1771 D: ab-root path-scope pre-pass ────────────────────────────────────

describe("guardrails root-scope pre-pass (#1771)", () => {
  let sandbox: string;
  let abmind: string;
  let abtars: string;
  let releases: string;
  let outside: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "guardrails-1771-"));
    // HOME-shaped layout so `~`-forms resolve hermetically. os.homedir()
    // honors $HOME per call on POSIX.
    abmind = join(sandbox, ".abmind");
    abtars = join(sandbox, ".abtars");
    releases = join(sandbox, ".abtars-releases");
    outside = join(sandbox, "outside");
    for (const d of [abmind, abtars, releases, outside]) mkdirSync(d, { recursive: true });
    mkdirSync(join(abtars, "node_modules"), { recursive: true });
    for (const key of ["HOME", "ABMIND_HOME", "ABTARS_HOME", "ABTARS_RELEASES"] as const) savedEnv[key] = process.env[key];
    process.env["HOME"] = sandbox;
    process.env["ABMIND_HOME"] = abmind;
    process.env["ABTARS_HOME"] = abtars;
    process.env["ABTARS_RELEASES"] = releases;
  });

  afterEach(() => {
    for (const key of ["HOME", "ABMIND_HOME", "ABTARS_HOME", "ABTARS_RELEASES"] as const) {
      const saved = savedEnv[key];
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("allows commands operating entirely inside the ab roots", () => {
    const cases: Array<[string, string]> = [
      ["in-root node script", `node ${abtars}/scripts/x.js`],
      ["in-root rm -rf (tilde form)", "rm -rf ~/.abtars/node_modules"],
      ["in-root git with -C value", `git -C ${abtars} clean -f`],
      ["in-root sudo rm (tilde form)", "sudo rm -rf ~/.abtars/cache"],
      ["in-root releases rm (tilde form)", "rm -rf ~/.abtars-releases/v1"],
      ["quoted heredoc to abmind", `cat > ${abmind}/m.md <<'EOF'\nhello\nEOF`],
      ["quoted heredoc body with $ stays eligible", "rm -rf ~/.abtars/x <<'EOF'\n$Y\nEOF"],
      ["in-root source", `source ${abtars}/x.sh`],
      ["relative script in rooted cwd", "./rel.sh"],
      ["bare word existing under rooted cwd", "rm -rf node_modules"],
      ["daily-ai review pipeline with glob and substitution", `ls -lt ~/.abtars/workspace/daily-ai/ | head -20; echo "---"; for f in $(ls -t ~/.abtars/workspace/daily-ai/*.md | head -4); do echo "== $f =="; grep -i -n "nvidia\\|open.source\\|opensource\\|github" "$f"`],
      ["arbitrary command syntax in rooted cwd", "npm run build"],
      ["nested privileged command in rooted cwd", "echo $(sudo rm -rf ~/.abtars/cache)"],
    ];
    for (const [name, command] of cases) {
      expect(classifyCommand(command, abtars), name).toBe("allow");
      expect(isRootScopeAllow(command, abtars), name).toBe(true);
    }
  });

  it("keeps explicit out-of-root paths on normal classification", () => {
    const cases: Array<[string, string, "allow" | "auth-required" | "block"]> = [
      ["literal absolute rm stays block via prefix", "rm -rf /tmp/test", "block"],
      ["node eval in rooted cwd", "node -e '1'", "allow"],
      ["bundled node eval in rooted cwd", "node -ce '1'", "allow"],
      ["perl uppercase eval in rooted cwd", "perl -E 'say 1'", "allow"],
      ["bash -c with gated payload in rooted cwd", "bash -c 'sudo id'", "allow"],
      ["dynamic target in rooted cwd", 'rm -rf "$TARGET"', "allow"],
      ["dynamic beside in-root operands", "rm -rf $DIR ~/.abtars/cache", "allow"],
      ["glob is allowed in rooted cwd", "rm -rf ~/.abtars/*", "allow"],
      ["secret subtree never in-root", "rm -rf ~/.abtars/secret/t", "auth-required"],
      ["unquoted expanding heredoc in rooted cwd", "rm -rf ~/.abtars/x <<EOF\necho $HOME\nEOF", "allow"],
      ["home documents", "rm -rf ~/Documents", "auth-required"],
      ["tilde-user refused", "rm -rf ~root/x", "auth-required"],
      ["root wipe stays block", "rm -rf /", "block"],
      ["out-of-root source", "source /tmp/x.sh", "auth-required"],
      ["bare word in unrooted cwd", "rm -rf node_modules", "auth-required"],
      ["sibling-prefix escape", "rm -rf ~/.abtars-evil/x", "auth-required"],
      ["dot-dot escape", "rm -rf ~/.abtars/../Documents", "auth-required"],
      ["nested out-of-root command", "echo $(rm -rf /tmp/test)", "block"],
    ];
    for (const [name, command, expected] of cases) {
      const cwd = name === "bare word in unrooted cwd" ? outside : abtars;
      expect(classifyCommand(command, cwd), name).toBe(expected);
      expect(isRootScopeAllow(command, cwd), name).toBe(expected === "allow");
    }
  });

  it("rejects malformed commands and accepts rooted commands without operands", () => {
    expect(isRootScopeAllow("", abtars)).toBe(false);
    expect(isRootScopeAllow("echo 'unterminated", abtars)).toBe(false);
    expect(isRootScopeAllow("npm run build", abtars)).toBe(true);
    expect(isRootScopeAllow("npm run build", outside)).toBe(false);
    expect(isRootScopeAllow("rm -rf /", abtars)).toBe(false);
  });

  it("rejects symlink traversal through a trusted root", () => {
    symlinkSync(outside, join(abtars, "escape"));
    const command = "rm -rf ~/.abtars/escape/new.txt";
    expect(classifyCommand(command, abtars)).toBe("auth-required");
    expect(isRootScopeAllow(command, abtars)).toBe(false);
  });
});
