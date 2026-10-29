# Prerequisites

## Runtime

abTARS requires Node.js 22.19 or newer and npm. Install a supported Node.js release for your operating system, then verify:

~~~bash
node --version
npm --version
~~~

Git is needed when using a development checkout or building from source.

## Choose an interface

Messaging is optional. Configure a Telegram bot, a Discord application, or use the local terminal interface. Follow [Installation](./install.md) for platform setup and credentials.

## Choose an execution route

- The pi-ai route uses Pi and a compatible API provider. The installation guide covers the Pi runtime and provider credentials.
- The ACP route uses an ACP-compatible agent CLI installed on the same machine.

Provider model IDs, authentication, and account requirements vary. See [Transport Configuration](./transport.md), [Provider Authentication](./pi-auth.md), and the provider's current documentation.

## Optional integrations

Install only the integrations you plan to use. abmind is a separate, optional memory system. Browser tools, MCP servers, and other optional dependencies are described in [Dependencies](./dependencies.md).

The normal user-local installation does not require administrator access. Installing operating-system packages or registering a system-scope service may require it; see [Installation](./install.md).
