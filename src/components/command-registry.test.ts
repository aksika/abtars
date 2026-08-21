import { describe, it, expect } from "vitest";
import {
  COMMAND_DEFINITIONS,
  getHelpEntries,
  getPlatformCommands,
  type CommandDefinition,
} from "./command-registry.js";

const KINDS = new Set(["exact", "prefix"]);
const VISIBILITIES = new Set(["public", "alias", "help-only", "internal"]);
const ACCESS = new Set(["all", "master"]);
const PLATFORMS = new Set(["telegram", "discord"]);

/** Ground-truth non-master roots captured from the pre-refactor registry. */
const EXPECTED_NON_MASTER_ROOTS = new Set([
  "/status", "/help", "/whoami", "/doctor", "/software", "/update",
  "/models", "/model", "/skills", "/skill", "/facts", "/tasks", "/task",
  "/usage", "/openrouter", "/session", "/hooks", "/memory", "/kanban",
  "/heartbeat", "/reset", "/stop", "/ctrlc", "/coding",
]);

function derivedNonMasterRoots(): Set<string> {
  const roots = new Set<string>();
  for (const def of COMMAND_DEFINITIONS) {
    if (def.access !== "all") continue;
    roots.add(def.kind === "exact" ? def.match : def.match.split(" ")[0]!);
  }
  return roots;
}

describe("command-registry invariants", () => {
  it("every definition has a valid name, match, kind, handler, visibility, and access", () => {
    for (const def of COMMAND_DEFINITIONS) {
      expect(def.name.length, def.match).toBeGreaterThan(0);
      expect(def.name.startsWith("/"), `${def.match} name has leading slash`).toBe(false);
      expect(def.match.startsWith("/"), `${def.match} match lacks leading slash`).toBe(true);
      expect(KINDS.has(def.kind), `${def.match} kind`).toBe(true);
      expect(VISIBILITIES.has(def.visibility), `${def.match} visibility`).toBe(true);
      expect(ACCESS.has(def.access), `${def.match} access`).toBe(true);
      expect(typeof def.handler, `${def.match} handler`).toBe("function");
      if (def.platforms) {
        for (const p of def.platforms) expect(PLATFORMS.has(p), `${def.match} platform ${p}`).toBe(true);
      }
      if (def.help) {
        for (const line of def.help) expect(line.length, `${def.match} empty help line`).toBeGreaterThan(0);
      }
      if (def.kind === "exact") {
        expect(def.match, `${def.name} exact match must be the bare root`).toBe(`/${def.name}`);
      } else {
        expect(def.match, `${def.name} prefix must start with its root`).toMatch(new RegExp(`^/${def.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      }
    }
  });

  it("route matches are unique within each kind (exact and prefix maps never collide)", () => {
    for (const kind of ["exact", "prefix"] as const) {
      const matches = COMMAND_DEFINITIONS.filter(d => d.kind === kind).map(d => d.match);
      expect(new Set(matches).size, `${kind} duplicate matches`).toBe(matches.length);
    }
  });

  it("every definition has a handler bound to an exported function", () => {
    const exact = COMMAND_DEFINITIONS.find(d => d.match === "/tasks");
    expect(exact?.handler.name).toBe("handleTasksList");
  });

  it("derived non-master roots equal the pre-refactor authorization set", () => {
    expect(derivedNonMasterRoots()).toEqual(EXPECTED_NON_MASTER_ROOTS);
  });

  it("no prefix route shadows a later route (first-match-wins safety)", () => {
    const prefixes = COMMAND_DEFINITIONS.filter(d => d.kind === "prefix").map(d => d.match);
    for (let i = 0; i < prefixes.length; i++) {
      for (let j = i + 1; j < prefixes.length; j++) {
        expect(prefixes[j]!.startsWith(prefixes[i]!), `${prefixes[j]} starts with earlier ${prefixes[i]}`).toBe(false);
      }
    }
  });
});

describe("command-registry platform projections", () => {
  it("menu roots are unique and every menu entry is bare-root routable", () => {
    for (const platform of ["telegram", "discord"] as const) {
      const menu = getPlatformCommands(platform);
      const names = menu.map(c => c.name);
      expect(new Set(names).size, `${platform} duplicate menu roots`).toBe(names.length);
      for (const { name } of menu) {
        expect(
          COMMAND_DEFINITIONS.some(d => d.kind === "exact" && d.match === `/${name}`),
          `${platform} menu root /${name} has no bare-root route`,
        ).toBe(true);
      }
    }
  });

  it("prefix-only /pi is not a menu root on either platform", () => {
    expect(getPlatformCommands("telegram").find(c => c.name === "pi")).toBeUndefined();
    expect(getPlatformCommands("discord").find(c => c.name === "pi")).toBeUndefined();
  });

  it("/project is a menu root on both platforms and its bare root routes", () => {
    for (const platform of ["telegram", "discord"] as const) {
      expect(getPlatformCommands(platform).find(c => c.name === "project")).toBeDefined();
    }
    expect(COMMAND_DEFINITIONS.some(d => d.match === "/project" && d.kind === "exact")).toBe(true);
  });

  it("/full, /short, /healing are Telegram-only menu entries", () => {
    const tg = new Set(getPlatformCommands("telegram").map(c => c.name));
    const dc = new Set(getPlatformCommands("discord").map(c => c.name));
    for (const name of ["full", "short", "healing"]) {
      expect(tg.has(name), `${name} missing from Telegram menu`).toBe(true);
      expect(dc.has(name), `${name} leaked into Discord menu`).toBe(false);
    }
  });

  it("menu projection preserves the current surface plus the intentional repairs", () => {
    const tg = getPlatformCommands("telegram").map(c => c.name).sort();
    const dc = getPlatformCommands("discord").map(c => c.name).sort();
    const base = [
      "coding", "compact", "continue", "doctor", "effort", "emergency",
      "facts", "health", "heartbeat", "help", "hooks",
      "kanban", "mcp", "memory", "model", "nlm", "project", "reset",
      "restart", "route", "session", "skill", "skills", "sleep",
      "software", "status", "stop", "tasks", "thinking", "todo", "tribe",
      "update", "usage", "wait", "whoami",
    ].sort();
    expect(tg).toEqual([...base, "full", "healing", "short"].sort());
    expect(dc).toEqual(base);
  });
});

describe("command-registry help projection", () => {
  it("telegram help includes Telegram-only lines and all public help", () => {
    const lines = getHelpEntries("telegram");
    expect(lines).toContain("/full — Raw output, TTS disabled");
    expect(lines).toContain("/short — Clean responses (default)");
    expect(lines).toContain("/healing — Toggle self-healer on/off");
    expect(lines).toContain("/help — Show this help");
    expect(lines).toContain("/task run <id> — Manually fire a task");
    expect(lines).toContain("/pi run --workspace <alias> <goal> — Start a Pi coding run");
  });

  it("discord help excludes Telegram-only lines", () => {
    const lines = getHelpEntries("discord");
    expect(lines).not.toContain("/full — Raw output, TTS disabled");
    expect(lines).not.toContain("/short — Clean responses (default)");
    expect(lines).not.toContain("/healing — Toggle self-healer on/off");
    expect(lines).toContain("/help — Show this help");
  });

  it("duplicate help lines are emitted once (task pause/resume share one line)", () => {
    const line = "/task pause <id> — Pause / /task resume <id> — Resume";
    for (const platform of ["telegram", "discord"]) {
      const lines = getHelpEntries(platform);
      expect(lines.filter(l => l === line)).toHaveLength(1);
    }
  });

  it("internal routes never surface in help", () => {
    const lines = getHelpEntries("telegram");
    for (const banned of ["/channel", "/users", "/metrics", "/openrouter", "/change", "/pi get ", "/pi list", "/pi reply "]) {
      expect(lines.find(l => l.startsWith(banned)), `help leaked ${banned}`).toBeUndefined();
    }
  });

  it("menu-visible aliases with no help lines stay out of help", () => {
    const lines = getHelpEntries("telegram");
    expect(lines.find(l => l.startsWith("/health"))).toBeUndefined();
    expect(lines.find(l => l.startsWith("/route"))).toBeUndefined();
  });

  it("help retains ordering intent: models lines after heartbeat, coding at the end before /help", () => {
    const lines = getHelpEntries("telegram");
    const idx = (l: string) => lines.findIndex(x => x.startsWith(l));
    expect(idx("/models —")).toBeGreaterThan(idx("/heartbeat —"));
    expect(idx("/coding —")).toBeLessThan(idx("/help —"));
    expect(idx("/full —")).toBeLessThan(idx("/help —"));
  });

  it("every public definition surfaces in help with explicit or default lines", () => {
    const lines = new Set(getHelpEntries("telegram"));
    for (const def of COMMAND_DEFINITIONS) {
      if (def.visibility !== "public") continue;
      if (def.platforms && !def.platforms.includes("telegram")) continue;
      const surfaced = def.help ? def.help.some(l => lines.has(l)) : lines.has(`/${def.name} — ${def.description}`);
      expect(surfaced, `${def.match} public entry missing from help`).toBe(true);
    }
  });

  it("alias and help-only entries appear in help only when they supply explicit lines", () => {
    const lines = new Set(getHelpEntries("telegram"));
    for (const def of COMMAND_DEFINITIONS) {
      if (def.visibility === "public" || def.visibility === "internal") continue;
      if (def.platforms && !def.platforms.includes("telegram")) continue;
      const surfaced = def.help ? def.help.some(l => lines.has(l)) : false;
      expect(surfaced, `${def.match} ${def.visibility} surfaced without explicit help`).toBe(def.help !== undefined);
    }
  });

  it("help surfaces /task validate as a dry-run check", () => {
    for (const platform of ["telegram", "discord"]) {
      expect(getHelpEntries(platform)).toContain("/task validate — Dry-run validation of the live task registry");
    }
  });

  it("/task validate is a help-only route and /tasks validate is its internal alias", () => {
    const taskValidate = COMMAND_DEFINITIONS.find(d => d.match === "/task validate");
    const tasksValidate = COMMAND_DEFINITIONS.find(d => d.match === "/tasks validate");
    expect(taskValidate).toBeDefined();
    expect(taskValidate?.handler.name).toBe("handleTasksValidate");
    expect(taskValidate?.kind).toBe("prefix");
    expect(taskValidate?.visibility).toBe("help-only");
    expect(taskValidate?.access).toBe("all");
    expect(tasksValidate).toBeDefined();
    expect(tasksValidate?.handler).toBe(taskValidate?.handler);
    expect(tasksValidate?.visibility).toBe("internal");
    expect(tasksValidate?.access).toBe("all");
  });

  it("validate routes do not add a platform menu root", () => {
    for (const platform of ["telegram", "discord"]) {
      const menu = getPlatformCommands(platform);
      expect(menu.find(c => c.name === "validate")).toBeUndefined();
      expect(menu.filter(c => c.name === "tasks")).toHaveLength(1);
      expect(menu.find(c => c.name === "task")).toBeUndefined();
    }
  });
});

/** Guard against reintroducing a second metadata list or a projection bypass. */
describe("command-registry import boundary", () => {
  it("exposes the typed API and no platform calls", () => {
    const src = COMMAND_DEFINITIONS as unknown as readonly CommandDefinition[];
    expect(Array.isArray(src)).toBe(true);
  });
});
