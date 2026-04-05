# AgentBridge Backlog

## High Priority

### [HIGH] ClawHub skill sync
**Added:** 2026-04-05
**Context:** ClawHub (clawhub.ai) hosts community skills that are just markdown files — same format AgentBridge already uses. SkillWatcher already hot-reloads skills from `~/.agentbridge/skills/`. We just need a download mechanism.

**Goal:** Pull skills from ClawHub and deploy them into the agent's skill directory.

**Design:**
1. CLI tool: `agentbridge-clawhub install <skill-id>` — downloads skill .md file(s) from ClawHub API, writes to `~/.agentbridge/skills/clawhub/<skill-id>/`
2. CLI tool: `agentbridge-clawhub list` — list installed ClawHub skills
3. CLI tool: `agentbridge-clawhub update` — re-download all installed skills (check for newer versions)
4. CLI tool: `agentbridge-clawhub remove <skill-id>` — delete skill directory
5. SkillWatcher picks up new/changed files automatically — no bridge restart needed
6. Optional: heartbeat task to auto-update installed skills daily

**Open questions:**
- ClawHub API authentication — does it need an API key or is it public?
- Skill format compatibility — are ClawHub skills plain .md or do they have frontmatter/metadata we need to parse?
- Conflict handling — what if a ClawHub skill name conflicts with a local skill?
- Version pinning — should we track installed versions to detect updates?

**Action items:**
- [ ] Research ClawHub API (endpoints, auth, skill format)
- [ ] Create `src/cli/agentbridge-clawhub.ts` with install/list/update/remove subcommands
- [ ] Create `~/.agentbridge/skills/clawhub/` directory convention
- [ ] Add `/clawhub` command handler for agent-initiated installs
- [ ] Optional: heartbeat task for auto-update

**Effort:** Low-medium (~100-150 lines). **Risk:** Low (additive, no existing code changes).

---

### [HIGH] Review A2A agent autonomy model
**Added:** 2026-03-28
**Context:** During memory-edit tool planning, the caller model incorrectly described KP as "acting on behalf of Molty." This is wrong — KP never acts on behalf of any external agent. The A2A relationship is strictly consultative: Molty can request help, but KP makes its own decisions independently. KP does not take direct instructions from peer agents.

**Action items:**
- Review `~/.agentbridge/skills/agents/MOLTY.md` — ensure wording reflects consulting relationship, not delegation
- Review `agent-api-server.ts` — verify the request handling doesn't imply KP is a proxy
- Review any steering/prompt that mentions agent interactions — ensure none frame KP as acting "on behalf of" another agent
- Clarify in SOUL.md or a dedicated steering: KP's autonomy is non-negotiable, peer agents are consultants not commanders
- When implementing memory-edit `--caller molty`: this means Molty calls the CLI tool directly with its own permissions, NOT that KP runs it for Molty

---

## Medium Priority

### [MEDIUM] Progress protocol for long-running CLI operations
**Added:** 2026-04-05
**Context:** Sleep cycle runs up to 55 minutes across 14 steps. Bridge has zero visibility into which step is running — only "process alive" or "process exited." Inspired by NemoClaw's `PROGRESS:<0-100>:<label>` stdout protocol.

**Goal:** CLI tools emit progress lines on stdout that the bridge can parse.

**Format:** `PROGRESS:<percent>:<step-name>` (e.g. `PROGRESS:35:04a-daily-summary`)

**Benefits:**
- `/status` shows current sleep step
- Dashboard displays sleep progress
- Watchdog can detect stuck steps earlier (progress stopped advancing)
- Works for other long CLIs too (batch embed, massedit)

**Action items:**
- [ ] Add `PROGRESS:` lines to `agentbridge-sleep.ts` at each step boundary
- [ ] Parse progress lines in bridge sleep spawn handler (read child stdout)
- [ ] Expose in `/status` and dashboard WebSocket push

**Effort:** Low (~30 lines). **Risk:** None (additive, stdout lines ignored if not parsed).

### [MEDIUM] Agent sandboxing (NemoClaw-style isolation)
**Added:** 2026-04-05
**Context:** All refactor prerequisites are now complete — Bridge class, capability plugin system, pluggable memory backends, CLI IPC. The architectural seams exist to split bridge (host) from agent (sandbox).

**Goal:** Run the agent (kiro-cli) inside a Docker container with deny-by-default network, read-only filesystem, no access to secrets. Bridge stays on host.

**Architecture:**
```
Host (unsandboxed): Bridge core, memory, platforms, dashboard
  │ ACP over stdio (already exists)
Sandbox (Docker): kiro-cli, agent tools, browser
  - Network: deny-by-default egress, allow kiro API only
  - Filesystem: read-only except /sandbox
  - No access to .env, memory.db, bridge code
```

**Action items:**
- [ ] Dockerfile for agent sandbox (reference: NemoClaw's 4-layer defense)
- [ ] Network policy (allow kiro API endpoint, block internal network)
- [ ] Credential isolation (secrets stay on host, agent gets tokens via ACP)
- [ ] Filesystem policy (read-only system, writable /sandbox only)
- [ ] Update ACP transport to spawn inside container instead of locally

**Reference:** NemoClaw — Landlock LSM, seccomp filters, capability drops, gateway proxy.

**Effort:** High. **Risk:** Medium. **Depends on:** All refactor items (done).
