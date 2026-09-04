/**
 * guardrails.ts — path + command restrictions for SECURITY_MODE=guardrails.
 * Defense-in-depth: catches accidental/confused model behavior, NOT adversarial bypass.
 */

import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { abmindHome, abtarsHome } from "../paths.js";
import { resolveReleasesDir } from "../cli/deploy-lib/paths.js";
import { getEnv } from "./env-schema.js";
import { logWarn } from "./logger.js";

const TAG = "guardrails";
const HOME = homedir();

const BLOCKED_PATHS = [
  `${HOME}/.ssh${sep}`,
  `${HOME}/.abtars/secret${sep}`,
  `/etc${sep}`,
  `/proc${sep}`,
  `/sys${sep}`,
  `/dev${sep}`,
  `/root${sep}`,
  `/run${sep}`,
];

const WRITE_BLOCKED = [
  `${HOME}/.abtars/config/peers.json`,
  `${HOME}/.kiro${sep}`,
];

const BLOCKED_COMMAND_PREFIXES = [
  "rm -rf /",
];

const SQL_DANGEROUS = [
  /\bDROP\s+(TABLE|DATABASE)\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
];

export type CommandTier = "block" | "auth-required" | "allow";

// Bounded recursion for nested evaluation inspection
const MAX_NESTED_DEPTH = 3;
const MAX_NESTED_BYTES = 8192;

interface ShellToken {
  value: string;
  operator: boolean;
  dynamic: boolean;
}

interface ShellSegment {
  tokens: ShellToken[];
}

interface HeredocBody {
  text: string;
  expands: boolean;
}

interface HeredocDescriptor extends HeredocBody {
  delimiter: string;
  stripTabs: boolean;
}

interface HeredocScan {
  visible: string;
  bodies: HeredocBody[];
  malformed: boolean;
}

interface ShellLexResult {
  segments: ShellSegment[];
  substitutions: string[];
  ambiguous: boolean;
}

const REDIRECT_OPERATORS = new Set(["<", ">", ">>", "<<", "<<<", ">&", "<&", "&>"]);
const INPUT_REDIRECT_OPERATORS = new Set(["<", "<<", "<<<", "<&"]);
const SHELL_INTERPRETERS = new Set(["bash", "sh", "dash", "zsh", "ksh"]);
const CONTROL_WORDS = new Set(["if", "while", "until", "for", "case", "function", "select"]);
const NESTED_WRAPPERS = new Set([
  "command", "exec", "builtin", "nohup", "time", "nice", "ionice", "timeout",
  "stdbuf", "chrt", "taskset", "setsid", "busybox", "toybox",
]);
const WRAPPER_OPTIONS_WITH_VALUES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["exec", new Set(["-a", "--argv0"])],
  ["nice", new Set(["-n", "--adjustment"])],
  ["ionice", new Set(["-c", "--class", "-n", "--classdata"])],
  ["timeout", new Set(["-k", "--kill-after", "-s", "--signal"])],
  ["stdbuf", new Set(["-i", "--input", "-o", "--output", "-e", "--error"])],
  ["taskset", new Set(["-p", "--pid", "-c", "--cpu-list"])],
]);
const WRAPPER_POSITIONAL_VALUES_TO_SKIP: ReadonlyMap<string, number> = new Map([
  ["timeout", 1], // duration precedes the command
  ["chrt", 1], // priority precedes the command
  ["taskset", 1], // CPU mask precedes the command (without -p)
]);
const CODE_INTERPRETERS = new Set(["node", "nodejs", "python", "python3", "perl", "ruby"]);
const DYNAMIC_SENSITIVE_COMMANDS = new Set(["rm", "git", "kill", "chmod", "find", "awk", "gawk", "mawk"]);

/** Classify a command into block / auth-required / allow. Payload-aware per #1752. */
export function classifyCommand(cmd: string, cwd?: string): CommandTier {
  return classifyInternal(typeof cmd === "string" ? cmd : "", 0, MAX_NESTED_BYTES, cwd ?? homedir());
}

/**
 * #1771: root-scope predicate shared by classification and audit tagging.
 * True when every path operand of the command resolves under the ab roots
 * (abmind/abtars/releases homes) with eval forms, dynamic tokens, expanding
 * heredocs, secret paths, and ambiguous lexes excluded. Pure: safe to call
 * for audit annotation alongside classifyCommand.
 */
export function isRootScopeAllow(cmd: string, cwd?: string): boolean {
  const input = typeof cmd === "string" ? cmd : "";
  const heredocs = maskHeredocBodies(input);
  if (heredocs.malformed) return false;
  const lexed = lexShell(heredocs.visible);
  return rootScopePrePass(lexed, heredocs.bodies, cwd ?? homedir());
}

function classifyInternal(cmd: string, depth: number, remainingBytes: number, cwd: string): CommandTier {
  if (depth > MAX_NESTED_DEPTH || remainingBytes <= 0) return "auth-required";

  const heredocs = maskHeredocBodies(cmd);
  if (heredocs.malformed) return "auth-required";
  const trimmed = heredocs.visible.trim();
  if (!trimmed) return "allow";
  for (const prefix of BLOCKED_COMMAND_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return "block";
  }

  const lexed = lexShell(heredocs.visible);
  if (lexed.ambiguous) return "auth-required";

  for (const payload of [...lexed.substitutions, ...heredocSubstitutions(heredocs.bodies)]) {
    if (!payload.trim()) return "auth-required";
    const nestedTier = classifyInternal(payload, depth + 1, remainingBytes - payload.length, cwd);
    if (nestedTier !== "allow") return nestedTier;
  }

  // #1771 D pre-pass: commands operating entirely inside the ab roots run
  // without a prompt. Runs before the per-segment loop so in-root
  // source/scripts also allow (intentional #1752 R2.4 deviation); can only
  // relax to allow, never tighten, and never overrides the block tier above.
  if (rootScopePrePass(lexed, heredocs.bodies, cwd)) return "allow";

  for (const segment of lexed.segments) {
    const executable = findExecutable(segment.tokens);
    if (!executable) continue;
    const executableToken = segment.tokens[executable.index];
    const word = executable.word.toLowerCase();
    const args = argsAfter(segment.tokens, executable.index);

    // `word` is basename-normalized for known command checks, so inspect the
    // original token too: a path-qualified executable may be an arbitrary
    // script and must not be treated as an ordinary command.
    const rawExecutable = executableToken?.value ?? "";
    const isPathQualifiedScript = rawExecutable.startsWith("./")
      || rawExecutable.startsWith("../")
      || /\.(?:sh|bash|zsh|ksh|py|pl|rb|js|mjs|cjs)$/i.test(rawExecutable);
    if (word === "source" || word === "." || isPathQualifiedScript) return "auth-required";
    if (CONTROL_WORDS.has(word)) return "auth-required";
    // A dynamic executable or a dynamic argument can change the command's
    // meaning after classification. Keep ordinary data arguments usable, but
    // fail closed for commands whose target/options are security-sensitive.
    if (segment.tokens[executable.index]?.dynamic) return "auth-required";
    if (DYNAMIC_SENSITIVE_COMMANDS.has(word) && args.some(token => token.dynamic)) return "auth-required";

    if (SHELL_INTERPRETERS.has(word)) {
      const commandIndex = optionIndex(segment.tokens, executable.index, new Set(["-c", "--command"]));
      if (commandIndex === null) return "auth-required";
      const payload = nextValue(segment.tokens, commandIndex + 1);
      if (!payload || payload.dynamic || !payload.value.trim()) return "auth-required";
      const nestedTier = classifyInternal(payload.value, depth + 1, remainingBytes - payload.value.length, cwd);
      if (nestedTier !== "allow") return nestedTier;
      continue;
    }

    if (word === "eval") {
      if (args.length === 0 || args.some(t => t.dynamic)) return "auth-required";
      const nestedTier = classifyInternal(args.map(t => t.value).join(" "), depth + 1, remainingBytes - args.reduce((n, t) => n + t.value.length, 0), cwd);
      if (nestedTier !== "allow") return nestedTier;
      continue;
    }

    if (["sqlite3", "psql", "mysql"].includes(word)) {
      // SQL interpreters execute their input. Dynamic arguments, external
      // input files, and shell-expanded heredocs are not safe file writes;
      // they are deliberately ambiguous at this boundary and fail closed.
      if (args.some(t => t.dynamic)) return "auth-required";
      const inputRedirects = inputRedirectValues(segment.tokens, executable.index);
      if (inputRedirects.some(input => input.operator !== "<<<" || input.dynamic)) return "auth-required";
      if (heredocs.bodies.some(body => body.expands && hasUnescapedExpansion(body.text))) return "auth-required";
      const sql = [
        ...args.map(t => t.value),
        ...inputRedirects.map(input => input.value),
        ...heredocs.bodies.map(b => b.text),
      ].join(" ");
      if (SQL_DANGEROUS.some(re => re.test(sql))) return "auth-required";
      if (/\.(?:read|import|shell|system)\b|(?:^|\s)\\!(?:\s|$)/i.test(sql)) return "auth-required";
      if (args.some(arg =>
        ["-f", "--file", "--source", "--execute", "-init"].includes(arg.value)
        || arg.value.startsWith("--file=")
        || arg.value.startsWith("--source=")
        || arg.value.startsWith("--init=")
      )) return "auth-required";
      continue;
    }

    const tier = classifyExecutable(word, args.map(t => t.value));
    if (tier !== "allow") return tier;
  }
  return "allow";
}

// ── #1771 D: ab-root path-scope pre-pass ─────────────────────────────────

/**
 * Allowed roots, resolved per call so ABMIND_HOME / ABTARS_HOME /
 * ABTARS_RELEASES overrides (and hermetic tests) work — never hardcoded
 * homedir() paths.
 */
function allowedBashRoots(): string[] {
  return [abmindHome(), abtarsHome(), resolveReleasesDir()];
}

function secretRoot(): string {
  return join(abtarsHome(), "secret");
}

function isUnder(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(root + sep);
}

/**
 * True when the lexed command operates exclusively inside the ab roots.
 * Fail-safe: every veto returns false (fall through to normal
 * classification); only a fully in-root operand set returns true.
 */
function rootScopePrePass(lexed: ShellLexResult, bodies: HeredocBody[], cwd: string): boolean {
  if (lexed.ambiguous) return false;
  if (lexed.segments.length === 0) return false;
  if (hasExpandingHeredocBody(bodies)) return false;
  if (hasEvalFlag(lexed)) return false;
  if (anyDynamicToken(lexed)) return false;
  if (hasRmRootTarget(lexed)) return false;
  return allPathOperandsInRoots(lexed, cwd);
}

function hasExpandingHeredocBody(bodies: HeredocBody[]): boolean {
  return bodies.some((b) => b.expands && hasUnescapedExpansion(b.text));
}

/** Any dynamic data token vetoes the pre-pass (fail closed). */
function anyDynamicToken(lexed: ShellLexResult): boolean {
  return lexed.segments.some((segment) => segment.tokens.some((t) => !t.operator && t.dynamic));
}

const EVAL_LONG_PREFIXES = ["--eval", "--command", "--exec"];

/**
 * Inline-code eval flags. Exact `-e`/`-c`/`-E` and `--eval*`/`--command*`/
 * `--exec*` (bare or `=value`) match on any executable — a veto only drops
 * the pre-pass shortcut, so over-matching is safe. Short-option bundles
 * containing e/c/E (`node -ce …`, `perl -E …`) are scoped to interpreter
 * executables so `git -C` and friends are unaffected.
 */
function hasEvalFlag(lexed: ShellLexResult): boolean {
  for (const segment of lexed.segments) {
    const found = findExecutable(segment.tokens);
    const word = found ? commandBasename(segment.tokens[found.index]!.value).toLowerCase() : "";
    const isInterpreter = CODE_INTERPRETERS.has(word) || SHELL_INTERPRETERS.has(word)
      || word === "sqlite3" || word === "psql" || word === "mysql" || word === "eval";
    for (let k = 0; k < segment.tokens.length; k++) {
      if (found && k === found.index) continue;
      const token = segment.tokens[k]!;
      if (token.operator) continue;
      const v = token.value;
      if (v === "-e" || v === "-c" || v === "-E") return true;
      // `--eval`, `--eval=…`, `--command…`, `--exec…` (but not `--exec-path`-style
      // double-dash compounds, which are ordinary options). Over-matching here
      // would only drop the pre-pass shortcut, never grant one.
      if (v.startsWith("--") && EVAL_LONG_PREFIXES.some((p) => v === p || v.startsWith(p + "=") || (v.startsWith(p) && !v.startsWith(p + "-")))) return true;
      if (isInterpreter && /^-[A-Za-z]+$/.test(v) && /[ecE]/.test(v)) return true;
    }
  }
  return false;
}

/** `rm` with a `/` target never takes the pre-pass (block tier owns it). */
function hasRmRootTarget(lexed: ShellLexResult): boolean {
  for (const segment of lexed.segments) {
    const found = findExecutable(segment.tokens);
    if (!found) continue;
    if (commandBasename(segment.tokens[found.index]!.value).toLowerCase() !== "rm") continue;
    for (const arg of argsAfter(segment.tokens, found.index)) {
      if (arg.value === "/") return true;
    }
  }
  return false;
}

/**
 * Every path operand must resolve under an allowed root (and outside the
 * secret dir). Path-like tokens count regardless of any preceding flag —
 * deliberately no flag-value bookkeeping: extra operands can only veto, so
 * imprecision here is fail-closed. Bare words count only when they exist on
 * disk under cwd. No operands at all → false (fall through).
 */
function allPathOperandsInRoots(lexed: ShellLexResult, cwd: string): boolean {
  const roots = allowedBashRoots();
  const secret = secretRoot();
  const home = homedir();
  let sawOperand = false;
  for (const segment of lexed.segments) {
    for (const token of segment.tokens) {
      if (token.operator) continue;
      const v = token.value;
      if (v === "-" || v.startsWith("-")) continue;
      if (token.dynamic) return false;
      const pathLike = v.startsWith("/") || v.startsWith("~") || v.startsWith(".") || v.includes("/");
      let resolved: string;
      if (pathLike) {
        // `~user/…` is refused outright: only bare `~` / `~/…` expand to home.
        if (v.startsWith("~") && v !== "~" && !v.startsWith("~/")) return false;
        resolved = v === "~" ? home : v.startsWith("~/") ? join(home, v.slice(2)) : resolve(cwd, v);
      } else {
        let candidate: string;
        try {
          candidate = resolve(cwd, v);
        } catch {
          return false;
        }
        if (!existsSync(candidate)) continue;
        resolved = candidate;
      }
      sawOperand = true;
      if (isUnder(resolved, secret)) return false;
      if (!roots.some((root) => isUnder(resolved, root))) return false;
    }
  }
  return sawOperand;
}

// ── executable classification ──────────────────────────────────────────────

function classifyExecutable(word: string, args: string[]): CommandTier {
  if (["sudo", "doas", "pkexec", "runuser", "su"].includes(word)) return "auth-required";
  if (word === "env" && args.some(arg => arg === "-S" || arg === "--split-string" || arg.startsWith("--split-string="))) return "auth-required";
  if (word === "rm") {
    let recursive = false;
    let force = false;
    const targets: string[] = [];
    for (const arg of args) {
      if (arg === "--") continue;
      if (arg.startsWith("--recursive")) recursive = true;
      else if (arg.startsWith("--force")) force = true;
      else if (arg.startsWith("-") && arg !== "-") {
        recursive ||= arg.slice(1).includes("r");
        force ||= arg.slice(1).includes("f");
      } else targets.push(arg);
    }
    if (recursive && force) return targets.includes("/") ? "block" : "auth-required";
  }
  if (word === "git") {
    const subcommand = gitSubcommand(args);
    if (subcommand === "reset" && args.some(arg => arg === "--hard" || arg.includes("hard"))) return "auth-required";
    if (subcommand === "push" && args.some(arg => arg === "--force" || arg.startsWith("--force-") || arg === "-f")) return "auth-required";
    if (subcommand === "clean" && args.some(arg => arg === "-f" || arg.includes("f"))) return "auth-required";
    if (subcommand === "branch" && args.some(arg => arg === "-D" || arg.includes("D"))) return "auth-required";
  }
  if (word === "kill" && args.some((arg, i) => arg === "-9" || /^--signal=(?:KILL|9)$/i.test(arg) || (arg === "--signal" && ["KILL", "9"].includes((args[i + 1] ?? "").toUpperCase())))) return "auth-required";
  if (word === "chmod" && args.includes("777")) return "auth-required";
  if (["drop", "truncate", "delete"].includes(word)) return "auth-required";
  if (["xargs", "parallel", "make"].includes(word)) return "auth-required";
  if (word === "find" && args.some(arg => ["-exec", "-execdir", "-delete"].includes(arg))) return "auth-required";
  if (["awk", "gawk", "mawk"].includes(word) && args.some(arg => /\bsystem\s*\(/i.test(arg))) return "auth-required";
  if (CODE_INTERPRETERS.has(word)) return "auth-required";
  return "allow";
}

function gitSubcommand(args: string[]): string | undefined {
  const optionsWithValues = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path", "--super-prefix"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return args[i + 1];
    if (optionsWithValues.has(arg)) { i++; continue; }
    if (arg.startsWith("--") || (arg.startsWith("-") && arg.length > 1)) continue;
    return arg;
  }
  return undefined;
}

function findExecutable(tokens: ShellToken[]): { word: string; index: number } | null {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.operator) {
      if (REDIRECT_OPERATORS.has(token.value)) i += 2;
      else i++;
      continue;
    }
    if (/^\d+$/.test(token.value) && tokens[i + 1]?.operator && REDIRECT_OPERATORS.has(tokens[i + 1]!.value)) {
      // Skip the fd, redirect operator, and its target (for example
      // `2>&1 sudo id`). The target is not a command word.
      i += 3;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) {
      i++;
      continue;
    }
    const word = commandBasename(token.value);
    if (word === "" || word === "!" || ["then", "do", "else", "elif", "fi", "done"].includes(word)) {
      i++;
      continue;
    }
    if (word === "env") {
      i++;
      while (i < tokens.length) {
        const next = tokens[i]!;
        if (next.operator) { i++; continue; }
        // GNU env -S/--split-string turns one data token into a new command
        // line. Its command grammar cannot be safely reconstructed here, so
        // return the wrapper itself and let classifyExecutable fail closed.
        if (next.value === "-S" || next.value === "--split-string" || next.value.startsWith("--split-string=")) {
          return { word, index: i - 1 };
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(next.value)) { i++; continue; }
        if (next.value === "--") { i++; break; }
        if (next.value === "-u" || next.value === "--unset") { i += 2; continue; }
        if (next.value.startsWith("-")) { i++; continue; }
        break;
      }
      continue;
    }
    if (NESTED_WRAPPERS.has(word)) {
      // `command -v`/`command -V` only inspect PATH and do not execute the
      // following word. Other wrappers may carry options before the actual
      // executable (for example `time -p bash -c ...` or `exec -a name bash`).
      if (word === "command" && ["-v", "-V", "--verbose"].includes(tokens[i + 1]?.value ?? "")) {
        return { word, index: i };
      }
      const wrapper = word;
      i++;
      let positionalToSkip = WRAPPER_POSITIONAL_VALUES_TO_SKIP.get(wrapper) ?? 0;
      while (i < tokens.length) {
        const next = tokens[i]!;
        if (next.operator) { i++; continue; }
        if (next.value === "--") { i++; break; }
        if (!next.value.startsWith("-")) {
          if (positionalToSkip > 0) { positionalToSkip--; i++; continue; }
          break;
        }
        const option = next.value;
        i++;
        if (wrapper === "taskset" && (
          option === "-p" || option === "--pid" || option.startsWith("--pid=")
          || option === "-c" || option === "--cpu-list" || option.startsWith("--cpu-list=")
          || option.startsWith("-p") || option.startsWith("-c")
        )) {
          // In taskset's PID and explicit CPU-list forms the value is consumed
          // by the option; it is not the positional mask that precedes a
          // command. Otherwise the default positional skip handles `taskset
          // 0 command`.
          positionalToSkip = 0;
        }
        const optionsWithValues = WRAPPER_OPTIONS_WITH_VALUES.get(wrapper);
        if (optionsWithValues?.has(option) && i < tokens.length) i++;
      }
      continue;
    }
    return { word, index: i };
  }
  return null;
}

function commandBasename(value: string): string {
  const slash = value.lastIndexOf("/");
  return slash >= 0 ? value.slice(slash + 1) : value;
}

function argsAfter(tokens: ShellToken[], index: number): ShellToken[] {
  const args: ShellToken[] = [];
  for (let i = index + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.operator) {
      if (REDIRECT_OPERATORS.has(token.value)) i++;
      continue;
    }
    args.push(token);
  }
  return args;
}

function inputRedirectValues(tokens: ShellToken[], index: number): Array<{ operator: string; value: string; dynamic: boolean }> {
  const inputs: Array<{ operator: string; value: string; dynamic: boolean }> = [];
  for (let i = index + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.operator || !INPUT_REDIRECT_OPERATORS.has(token.value)) continue;
    // The following token is only the delimiter for a heredoc. Its actual
    // executable input is collected by maskHeredocBodies().
    if (token.value === "<<") { i++; continue; }
    const value = nextValue(tokens, i + 1);
    if (value) inputs.push({ operator: token.value, value: value.value, dynamic: value.dynamic });
    i++;
  }
  return inputs;
}

function hasUnescapedExpansion(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "$" || text[i] === "`") return true;
  }
  return false;
}

function optionIndex(tokens: ShellToken[], start: number, options: Set<string>): number | null {
  for (let i = start + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.operator && options.has(token.value)) return i;
  }
  return null;
}

function nextValue(tokens: ShellToken[], start: number): ShellToken | null {
  for (let i = start; i < tokens.length; i++) {
    if (!tokens[i]!.operator) return tokens[i]!;
  }
  return null;
}

function maskHeredocBodies(input: string): HeredocScan {
  const lines = input.split("\n");
  const visible = [...lines];
  const bodies: HeredocBody[] = [];
  const pending: Array<HeredocDescriptor & { lines: string[] }> = [];
  let malformed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (pending.length > 0) {
      const current = pending[0]!;
      const candidate = current.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === current.delimiter) {
        visible[i] = maskLine(line);
        bodies.push({ text: current.lines.join("\n"), expands: current.expands });
        pending.shift();
        continue;
      }
      current.lines.push(line);
      visible[i] = maskLine(line);
      continue;
    }

    const scan = heredocDescriptors(line);
    if (scan.malformed) malformed = true;
    for (const descriptor of scan.descriptors) pending.push({ ...descriptor, lines: [] });
  }
  if (pending.length > 0) malformed = true;
  return { visible: visible.join("\n"), bodies, malformed };
}

function maskLine(line: string): string {
  return " ".repeat(line.length);
}

function heredocDescriptors(line: string): { descriptors: HeredocDescriptor[]; malformed: boolean } {
  const descriptors: HeredocDescriptor[] = [];
  let quote: "single" | "double" | null = null;
  let escaped = false;
  let malformed = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (escaped) { escaped = false; continue; }
    if (quote === "single") { if (c === "'") quote = null; continue; }
    if (quote === "double") {
      if (c === "\\") escaped = true;
      else if (c === '"') quote = null;
      continue;
    }
    if (c === "\\") { escaped = true; continue; }
    if (c === "'") { quote = "single"; continue; }
    if (c === '"') { quote = "double"; continue; }
    // A here-string (`<<<`) contains two overlapping `<<` pairs. Only the
    // first `<` can begin a heredoc descriptor; the later characters must
    // remain part of the shell operator.
    if (c !== "<" || line[i + 1] !== "<" || line[i - 1] === "<" || line[i + 2] === "<") continue;

    let j = i + 2;
    const stripTabs = line[j] === "-";
    if (stripTabs) j++;
    while (/\s/.test(line[j] ?? "")) j++;
    if (!line[j]) { malformed = true; continue; }

    let expands = true;
    let delimiter = "";
    if (line[j] === "'" || line[j] === '"') {
      const q = line[j]!;
      expands = false;
      j++;
      const start = j;
      while (j < line.length && line[j] !== q) j++;
      if (j >= line.length) { malformed = true; continue; }
      delimiter = line.slice(start, j);
      j++;
    } else {
      while (j < line.length && !/\s|[;&|<>]/.test(line[j]!)) {
        if (line[j] === "\\" && j + 1 < line.length) {
          expands = false;
          delimiter += line[j + 1]!;
          j += 2;
        } else {
          delimiter += line[j]!;
          j++;
        }
      }
    }
    if (!delimiter) malformed = true;
    else descriptors.push({ delimiter, stripTabs, expands, text: "" });
    i = Math.max(i, j - 1);
  }
  return { descriptors, malformed };
}

function heredocSubstitutions(bodies: HeredocBody[]): string[] {
  const payloads: string[] = [];
  for (const body of bodies) {
    if (!body.expands) continue;
    for (let i = 0; i < body.text.length; i++) {
      if (body.text[i] === "\\") { i++; continue; }
      if (body.text[i] === "$" && body.text[i + 1] === "(") {
        const nested = readCommandSubstitution(body.text, i);
        if (!nested) return [""];
        payloads.push(nested.payload);
        i = nested.end;
      } else if (body.text[i] === "`") {
        const nested = readBacktick(body.text, i);
        if (!nested) return [""];
        payloads.push(nested.payload);
        i = nested.end;
      }
    }
  }
  return payloads;
}

function lexShell(input: string): ShellLexResult {
  const segments: ShellSegment[] = [{ tokens: [] }];
  const substitutions: string[] = [];
  let value = "";
  let started = false;
  let dynamic = false;
  let quote: "single" | "double" | null = null;
  let ambiguous = false;

  const flush = (): void => {
    if (!started) return;
    segments.at(-1)!.tokens.push({ value, operator: false, dynamic });
    value = "";
    started = false;
    dynamic = false;
  };
  const separate = (): void => {
    flush();
    if (segments.at(-1)!.tokens.length > 0) segments.push({ tokens: [] });
  };
  const operator = (op: string): void => {
    flush();
    segments.at(-1)!.tokens.push({ value: op, operator: true, dynamic: false });
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote === "single") {
      if (c === "'") quote = null;
      else value += c;
      continue;
    }
    if (quote === "double") {
      if (c === '"') { quote = null; continue; }
      if (c === "\\" && i + 1 < input.length) { value += input[++i]!; started = true; continue; }
      if (c === "$" && input[i + 1] === "(") {
        const nested = readCommandSubstitution(input, i);
        if (!nested) { ambiguous = true; break; }
        substitutions.push(nested.payload);
        dynamic = true;
        started = true;
        i = nested.end;
        continue;
      }
      if (c === "`") {
        const nested = readBacktick(input, i);
        if (!nested) { ambiguous = true; break; }
        substitutions.push(nested.payload);
        dynamic = true;
        started = true;
        i = nested.end;
        continue;
      }
      if (c === "$") {
        // Variable expansion can change SQL or a nested command argument even
        // when it is inside double quotes. Single-quoted data never reaches
        // this branch and remains inert.
        value += c;
        dynamic = true;
        started = true;
        continue;
      }
      value += c;
      started = true;
      continue;
    }

    if (/\s/.test(c)) {
      if (c === "\n") separate();
      else flush();
      continue;
    }
    if (c === "#" && !started) {
      while (i + 1 < input.length && input[i + 1] !== "\n") i++;
      continue;
    }
    if (c === "'") { quote = "single"; started = true; continue; }
    if (c === '"') { quote = "double"; started = true; continue; }
    if (c === "\\") {
      if (i + 1 >= input.length) { ambiguous = true; break; }
      value += input[++i]!;
      started = true;
      continue;
    }
    if (c === "$" && input[i + 1] === "(") {
      const nested = readCommandSubstitution(input, i);
      if (!nested) { ambiguous = true; break; }
      substitutions.push(nested.payload);
      dynamic = true;
      started = true;
      i = nested.end;
      continue;
    }
    if (c === "`") {
      const nested = readBacktick(input, i);
      if (!nested) { ambiguous = true; break; }
      substitutions.push(nested.payload);
      dynamic = true;
      started = true;
      i = nested.end;
      continue;
    }
    if (c === ";" || c === "|" || c === "&") {
      if ((c === "&" && (input[i - 1] === ">" || input[i - 1] === "<")) || (c === "|" && input[i - 1] === "|")) {
        operator(c);
        continue;
      }
      if (input[i + 1] === c) i++;
      separate();
      continue;
    }
    if (c === "<" || c === ">") {
      flush();
      const next = input[i + 1];
      if (c === "<" && next === "<" && input[i + 2] === "<") { operator("<<<"); i += 2; }
      else if (c === "<" && next === "<") { operator("<<"); i++; }
      else if (next === c) { operator(c + c); i++; }
      else if (next === "&") { operator(c + "&"); i++; }
      else { operator(c); }
      continue;
    }
    if (c === "(" || c === ")" || c === "{" || c === "}") {
      ambiguous = true;
      continue;
    }
    value += c;
    started = true;
    if (c === "$" || c === "*") dynamic = true;
  }
  if (quote !== null) ambiguous = true;
  flush();
  return { segments: segments.filter(segment => segment.tokens.length > 0), substitutions, ambiguous };
}

function readCommandSubstitution(input: string, start: number): { payload: string; end: number } | null {
  let depth = 1;
  let quote: "single" | "double" | null = null;
  let backtick = false;
  for (let i = start + 2; i < input.length; i++) {
    const c = input[i]!;
    if (c === "\\") { i++; continue; }
    if (backtick) { if (c === "`") backtick = false; continue; }
    if (quote === "single") { if (c === "'") quote = null; continue; }
    if (quote === "double") {
      if (c === '"') quote = null;
      else if (c === "`") backtick = true;
      else if (c === "$" && input[i + 1] === "(") { depth++; i++; }
      else if (c === ")") { depth--; if (depth === 0) return { payload: input.slice(start + 2, i), end: i }; }
      continue;
    }
    if (c === "'") { quote = "single"; continue; }
    if (c === '"') { quote = "double"; continue; }
    if (c === "`") { backtick = true; continue; }
    if (c === "$" && input[i + 1] === "(") { depth++; i++; continue; }
    if (c === ")") { depth--; if (depth === 0) return { payload: input.slice(start + 2, i), end: i }; }
  }
  return null;
}

function readBacktick(input: string, start: number): { payload: string; end: number } | null {
  for (let i = start + 1; i < input.length; i++) {
    if (input[i] === "\\") { i++; continue; }
    if (input[i] === "`") return { payload: input.slice(start + 1, i), end: i };
  }
  return null;
}

export type SecurityMode = "off" | "guardrails" | "seatbelt" | "docker";

export function getSecurityMode(): SecurityMode {
  const mode = getEnv().securityMode as SecurityMode;
  return mode || "off";
}

export function isGuardrailsActive(): boolean {
  return getSecurityMode() !== "off";
}

export function isSeatbeltActive(): boolean {
  const m = getSecurityMode();
  return m === "seatbelt" || m === "docker";
}

export function isDockerActive(): boolean {
  return getSecurityMode() === "docker";
}

/** Check if a file path is allowed. Returns error message or null if OK. */
export function checkPath(path: string, mode: "read" | "write"): string | null {
  if (!isGuardrailsActive()) return null;

  const resolved = resolve(path) + (path.endsWith("/") ? sep : "");

  for (const blocked of BLOCKED_PATHS) {
    if (resolved.startsWith(blocked) || resolved === blocked.slice(0, -1)) {
      return `Path blocked by guardrails: ${path}`;
    }
  }

  if (mode === "write") {
    for (const wb of WRITE_BLOCKED) {
      if (resolved.startsWith(wb) || resolved === wb) {
        return `Write blocked by guardrails: ${path}`;
      }
    }
  }

  return null;
}

/** Check if a bash command is allowed. Returns error message or null if OK. */
export function checkCommand(cmd: string, cwd?: string): string | null {
  if (!isGuardrailsActive()) return null;

  const tier = classifyCommand(cmd, cwd);
  if (tier === "block") {
    logWarn(TAG, `Blocked command: ${cmd.slice(0, 100)}`);
    return `Command blocked by guardrails: ${cmd.slice(0, 60)}`;
  }
  // "auth-required" is handled by action-gate at a higher level — not blocked here
  return null;
}
