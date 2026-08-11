# Prerequisites

Before installing abTARS, make sure you have the following.

## Node.js 22+ (required)

abTARS requires Node.js 22 or later. Recommended: Node.js 24 (latest even release).

**macOS (Homebrew):**

```bash
brew install node@24
brew link node@24
node --version   # should show v24.x.x
```

**Linux / WSL (NodeSource):**

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # should show v24.x.x
```

**Using nvm:**

```bash
nvm install 24 && nvm use 24 && nvm alias default 24
node --version   # should show v24.x.x
```

## git (required)

```bash
git --version   # any recent version
```

## Telegram bot token (required)

Create a bot via [@BotFather](https://t.me/BotFather) on Telegram. You'll need:
- The bot token (e.g. `123456:ABC-DEF...`)
- Your chat ID (send `/start` to [@userinfobot](https://t.me/userinfobot))

## Model provider (at least one)

| Provider | Type | Setup |
|----------|------|-------|
| **ollama** | Local, free | `curl -fsSL https://ollama.ai/install.sh \| sh` (Linux) or `brew install ollama` (macOS) |
| **OpenRouter** | Cloud, aggregator | Sign up at [openrouter.ai](https://openrouter.ai), get an API key. Access to all major models. |
| **OpenAI** | Cloud, direct | API key from [platform.openai.com](https://platform.openai.com) |
| **Anthropic** | Cloud, direct | API key from [console.anthropic.com](https://console.anthropic.com) |
| **Kiro CLI** | Local AI coding tool | Install [Kiro](https://kiro.dev) separately |
| **Gemini CLI** | Local AI coding tool | Install [Gemini CLI](https://github.com/google-gemini/gemini-cli) separately |

### Model requirements

abTARS works with any LLM that supports the OpenAI chat completions API format, including local models via ollama.

| | Minimum | Recommended |
|---|---|---|
| **Context window** | 32K tokens | 128K+ tokens |
| **Model quality** | Any instruction-following model | State-of-the-art (GPT-4o, Claude, Gemini Pro, DeepSeek V3+) |

**Context window:** abTARS works with 32K models, but tool use eats context fast. 128K+ recommended for comfortable operation.

**Model quality and security:** abTARS injects persona, memory, and tool schemas into the system prompt. Weaker models may leak instructions or follow injected prompts from user messages. For production, use frontier models.

## Optional dependencies

| Dependency | What for | macOS | Linux/WSL |
|-----------|----------|-------|-----------|
| ollama | Local embeddings + models | `brew install ollama` | See [ollama.ai](https://ollama.ai) |
| bubblewrap | Sandbox (Linux only) | N/A | `apt install bubblewrap` |
| lightpanda | Fast web fetch | See [lightpanda.io](https://lightpanda.io) | See [lightpanda.io](https://lightpanda.io) |

Install all optional npm deps with one command once the CLI is available:

```bash
abtars deps install all
```

## Do I need sudo? No.

abtars and abmind install, update, and run entirely in user space.

| Component | Location |
|-----------|----------|
| Node + npm packages | `~/.nvm/versions/node/...` (nvm) or `~/.npm-global/` |
| abtars releases | `~/.abtars-releases/` |
| abtars runtime | `~/.abtars/` |
| abmind data | `~/.abmind/` |
| Watchdog service | `~/Library/LaunchAgents/` (macOS) or `~/.config/systemd/user/` (Linux) |
| Native deps | `~/.local/lib/node_modules/` |

No system paths. No `/usr/local/`. No `/etc/`. No root.

**One exception — systemd linger (Linux only):** for the bridge to survive a reboot as a user systemd service, you may need to enable linger once:

```bash
sudo loginctl enable-linger $USER
```

That's a one-time system admin action. After that, you never need sudo again.

**The optional system binaries above** (ollama, bwrap, lightpanda) are the only things that might ask for sudo — and only because their own upstream installers do (e.g. `apt install bubblewrap`). abtars itself never runs a system installer or `sudo` for you: `abtars deps install ollama` just prints the command to install it yourself.

**If npm defaults to `/usr/local/` (macOS):** macOS ships with npm pointing at `/usr/local/`, which requires sudo for `npm install -g`. Fix with one of:

- **Redirect npm globals to your home dir:**
  ```bash
  npm config set prefix ~/.npm-global
  echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
  ```
- **Use nvm (recommended):** nvm installs Node + npm under `~/.nvm/` — no sudo, multiple Node versions, no config needed. See [Node.js 22+](#node-js-22-required) above.

Ready? Go to [Installation](./install.md).
