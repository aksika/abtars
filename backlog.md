# AgentBridge Backlog

## High Priority

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
