# Mid-Run Steering

Inject messages into a running agent without interrupting it, or hard-stop a generation.

## Commands

| Command | Alias | What it does |
|---------|-------|-------------|
| `/wait [message]` | `/steer` | Non-interrupting. Injects your text between tool rounds. |
| `/stop` | `/ctrlc` | Hard interrupt. Kills the current generation immediately. |

## How `/wait` works

1. You send `/wait Don't forget to also check the logs`
2. The busy-guard queues your text into the session's generation-bound instruction queue
3. Between the agent's next tool calls, it sees: `[USER] Wait! Don't forget to also check the logs`
4. The agent incorporates your guidance and continues working

The agent is NOT interrupted — it finishes its current tool call, reads your injection, then adapts.

## Transport behavior

| Transport | Injection timing |
|-----------|-----------------|
| Pi API route | Between tool calls (true mid-run), via session steering with native bounds |
| ACP | After prompt completes (best-effort, injected as follow-up; ACP session steering is not maintained) |

## Multiple `/wait` messages

If you send several `/wait` before the agent drains them, they're concatenated with newlines. All delivered together at the next drain point.

## `/wait` while idle

If the agent isn't busy, there is no queue to inject into:

- `/wait` with no text while idle replies that nothing is running
- `/wait <message>` with text while idle is treated as a normal message

## `/stop` behavior

Immediately kills the current generation. The agent stops, and you can send a new message. Use when the agent is going down the wrong path and you don't want to wait.

## Legacy

There is no bare `wait` command — steering goes through `/wait` and `/steer`.
