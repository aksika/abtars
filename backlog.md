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
