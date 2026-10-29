# Quick Start

This guide covers the choices to make before installing abTARS. For the full setup, see [Installation](./install.md).

## What you need

1. A machine that can stay available while you use the agent.
2. Node.js 22.19 or newer and npm.
3. An interface: a Telegram bot or Discord application for messaging, or the local terminal interface, if enabled.
4. An execution route:
   - The pi-ai route uses Pi and an API provider configured for your selected model.
   - The ACP route uses an ACP-compatible agent CLI.

See [Installation](./install.md) for exact setup steps and credentials.

## Choose how it runs

| Mode | What it means |
|------|--------------|
| daemon | Installs an operating-system service that starts the watchdog and recovers the bridge after failures. |
| simple | Runs without the operating-system service. You start and stop it yourself. |

## Install and verify

Follow the [Installation guide](./install.md). Then check the bridge:

~~~bash
abtars status
abtars doctor
~~~

Send a message through your configured platform, or open the local terminal interface if you enabled it.

## Useful commands

| Command | What it does |
|---------|-------------|
| /status | Show bridge status and uptime |
| /models | Show the current model and route |
| /new | Start a fresh conversation |
| /sleep | Show sleep status |
| /help | List available commands |

## Memory and personalization

abmind is optional and installed separately. When using it, follow the [abmind setup guide](/abmind/install) to configure persistent memory and personalize the agent.

## Updating

Run abtars update with the channel you want to use, such as --alpha for alpha releases. See [Upgrading](./upgrade.md) for the update and rollback steps.

## Security

Keep bot credentials private and configure which user IDs may contact the agent. Do not rely on an unlisted bot name as access control. abTARS can run tools on the machine where it is installed, so grant access deliberately.
