# Agent Swarm

abTARS can coordinate agent work through bounded worker tasks and a local Kanban board.

## Local task orchestration

An orchestrator can split a larger task into worker tasks, track their status, and wait for prerequisite tasks before starting dependent work. The task configuration sets the maximum number of agents for an orchestration.

Use the Kanban tools or the /kanban command to inspect active work and results. The number of workers is bounded by the task's orchestration settings.

## Work with another abTARS instance

Two peer tools cover different kinds of interaction:

- peer_session supports discussion and follow-up questions. It is a cardless conversation without tools or side effects.
- peer_ask_help delegates durable work to another configured instance, which can accept or decline the request and return a result.

Peers are configured explicitly. abTARS does not discover peer instances automatically. See [Peer-to-Peer](./peers.md) for setup and security details.
