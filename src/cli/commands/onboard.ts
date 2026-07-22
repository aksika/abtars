import { printBanner } from './banner.js';
import { deriveFromPassphrase, writeKeyFile, writeKeyVerify, deriveKey } from '../../utils/crypto.js';
/**
 * `abtars install` — first-time interactive configuration wizard
 * (plan #158 Phase 3, subsumes ticket #153).
 *
 * Two modes:
 *   - Interactive (default): @clack/prompts wizard asks for bot token,
 *     chat ID, transport provider, etc. Writes config/.env + config/users.json.
 *   - Non-interactive: --non-interactive --accept-risk with explicit flags
 *     for every choice. Fails if any required flag is missing.
 *
 * Scope (kept minimal — plan caps at ~200 LOC):
 *   Prompts cover: Telegram bot token + primary chat ID, default transport
 *   provider (openrouter | anthropic | openai), default model, optional
 *   Discord a2a channel.
 *
 *   Out of scope for Phase 3:
 *   - Channel allowlist/users.json multi-user editing (#67 / #204)
 *   - Skills configuration (each skill's .env key)
 *   - Transport provider credentials beyond DEFAULT_PROVIDER (operator
 *     edits config/.env directly post-install)
 */

import { logAndSwallow } from "../../components/log-and-swallow.js";
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { packagePaths, readManifest, resolveReleasesDir } from '../deploy-lib-import.js';
import { showHintOnce } from '../../components/hints.js';

export interface OnboardOptions {
  readonly nonInteractive: boolean;
  readonly acceptRisk: boolean;
  readonly telegramToken?: string;
  readonly telegramChatId?: string;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly apiKey?: string;
  readonly discordA2aChannel?: string;
  readonly userName?: string;
  readonly instanceName?: string;
  readonly passphrase?: string;
  readonly force: boolean;
  readonly source?: 'dev' | 'alpha' | 'stable';
  readonly localDir?: string;
}

type ProviderChoice = 'openrouter' | 'anthropic' | 'openai' | 'ollama' | 'kiro' | 'gemini';

const VALID_PROVIDERS: readonly ProviderChoice[] = ['openrouter', 'anthropic', 'openai', 'ollama', 'kiro', 'gemini'];

/** Map onboard choice → transport.json provider name */
const PROVIDER_TRANSPORT_NAME: Record<ProviderChoice, string> = {
  openrouter: 'openrouter',
  anthropic: 'anthropic',
  openai: 'openai',
  ollama: 'ollama',
  kiro: 'kiro',
  gemini: 'gemini',
};
const DEFAULT_MODELS: Record<ProviderChoice, string> = {
  openrouter: 'deepseek/deepseek-v4-flash',
  anthropic: 'claude-sonnet-4-5-20250929',
  openai: 'gpt-4o',
  ollama: 'kimi-k2.5:cloud',
  kiro: 'claude-sonnet-4.6',
  gemini: 'gemini-2.5-flash',
};

/** Providers that use an API key + HTTP endpoint (can validate via /v1/models). */
const API_PROVIDERS: ReadonlySet<ProviderChoice> = new Set(['openrouter', 'anthropic', 'openai', 'ollama']);

const PROVIDER_ENDPOINT: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
};

const PROVIDER_API_KEY_ENV: Record<ProviderChoice, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  ollama: 'OLLAMA_API_KEY',
  kiro: 'KIRO_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

interface WizardAnswers {
  readonly installMode: "simple" | "daemon";
  readonly userName: string;
  readonly instanceName: string;
  readonly passphrase: string;
  readonly telegramToken: string;
  readonly telegramChatId: string;
  readonly discordBotToken: string;
  readonly discordAppId: string;
  readonly discordA2aChannel: string;
  readonly defaultProvider: ProviderChoice;
  readonly defaultModel: string;
  readonly providerApiKey: string;
  readonly hailMaryModel: string;
  readonly groqApiKey: string;
  readonly securityMode: string;
  readonly trustMode: boolean;
}


async function runInteractive(existing: WizardAnswers | null): Promise<WizardAnswers | null> {
  const { intro, outro, text, select, confirm, isCancel, cancel } = await import('@clack/prompts');

  intro('abtars onboard — first-time setup');

  let userName = '';

  // 1. Agent name
  const instanceName = await text({
    message: 'abTARS agent name',
    placeholder: 'MyBot',
    initialValue: existing?.instanceName ?? '',
    validate: (v) => v?.trim() ? undefined : 'required',
  });
  if (isCancel(instanceName)) { cancel('Cancelled.'); return null; }

  // 2. Install mode
  const installMode = await select({
    message: 'Install mode',
    options: [
      { value: 'daemon', label: 'daemon — auto-restart, survives reboot (recommended)' },
      { value: 'simple', label: 'simple — manual start/stop' },
    ],
    initialValue: existing?.installMode ?? 'daemon',
  });
  if (isCancel(installMode)) { cancel('Cancelled.'); return null; }

  // 2b. Your name (used for encryption + user identity)
  if (!userName) {
    const uname = await text({
      message: 'Your name (used for encryption + identity)',
      placeholder: 'aksika',
      validate: (v) => v?.trim() ? undefined : 'required',
    });
    if (isCancel(uname)) { cancel('Cancelled.'); return null; }
    userName = String(uname).trim();
  }

  // 2c. Encryption passphrase (mandatory — protects secrets at rest)
  const passphrase = await text({
    message: 'Encryption passphrase (protects secrets at rest)',
    placeholder: 'choose a strong passphrase',
    validate: (v) => v?.trim() ? undefined : 'required — secrets are encrypted with this',
  });
  if (isCancel(passphrase)) { cancel('Cancelled.'); return null; }

  // 3. Security mode
  const securityMode = await select({
    message: 'Security mode',
    options: [
      { value: 'off', label: 'off — no restrictions (ActionGate still active)' },
      { value: 'guardrails', label: 'guardrails — path guard + command blocklist (recommended)' },
      { value: 'seatbelt', label: 'seatbelt — guardrails + OS per-command sandbox (bwrap/sandbox-exec)' },
      { value: 'docker', label: 'docker — full isolation: per-session Docker containers (requires Docker)' },
    ],
    initialValue: existing?.securityMode ?? 'guardrails',
  });
  if (isCancel(securityMode)) { cancel('Cancelled.'); return null; }

  // 4. Main chat ID
  const telegramChatId = await text({
    message: 'Main chat ID (Telegram)',
    placeholder: '123456789',
    initialValue: existing?.telegramChatId ?? '',
    validate: (v) => (!v || /^-?\d+$/.test(v.trim())) ? undefined : 'expected numeric ID',
  });
  if (isCancel(telegramChatId)) { cancel('Cancelled.'); return null; }

  // 5. Telegram bot token
  const telegramToken = await text({
    message: 'Telegram bot token (@BotFather)',
    placeholder: '123456789:ABCdefGHI...',
    initialValue: existing?.telegramToken ?? '',
    validate: (v) => (!v || v.includes(':')) ? undefined : 'expected format "id:secret"',
  });
  if (isCancel(telegramToken)) { cancel('Cancelled.'); return null; }

  // 6-8. Discord (optional)
  const noteEmpty = 'Enter to skip';
  const discordBotToken = await text({
    message: `Discord bot token (${noteEmpty})`,
    placeholder: 'MTIzNDU2...',
    initialValue: existing?.discordBotToken,
  });
  if (isCancel(discordBotToken)) { cancel('Cancelled.'); return null; }

  const discordAppId = await text({
    message: `Discord app ID (${noteEmpty})`,
    placeholder: '987654321098765432',
    initialValue: existing?.discordAppId,
    validate: (v) => (!v || v.trim() === '' || /^\d{10,20}$/.test(v.trim())) ? undefined : 'expected snowflake or empty',
  });
  if (isCancel(discordAppId)) { cancel('Cancelled.'); return null; }

  const discordA2aChannel = await text({
    message: `Discord channel ID (${noteEmpty})`,
    placeholder: '987654321098765432',
    initialValue: existing?.discordA2aChannel,
    validate: (v) => (!v || v.trim() === '' || /^\d{10,20}$/.test(v.trim())) ? undefined : 'expected snowflake or empty',
  });
  if (isCancel(discordA2aChannel)) { cancel('Cancelled.'); return null; }

  // 9. Provider
  const defaultProvider = await select<ProviderChoice>({
    message: "Model's provider (use /model to change later)",
    options: [
      { value: 'openrouter', label: 'openrouter — many models via API key' },
      { value: 'anthropic', label: 'anthropic — Claude API (direct)' },
      { value: 'openai', label: 'openai — GPT API (direct)' },
      { value: 'ollama', label: 'ollama — local/cloud Ollama endpoint' },
      { value: 'kiro', label: 'kiro — Kiro CLI' },
      { value: 'gemini', label: 'gemini — Gemini CLI' },
    ],
    initialValue: existing?.defaultProvider ?? 'openrouter',
  });
  if (isCancel(defaultProvider)) { cancel('Cancelled.'); return null; }

  // 10. Main model (prefilled per provider)
  const defaultModel = await text({
    message: 'Main model',
    placeholder: DEFAULT_MODELS[defaultProvider],
    initialValue: existing?.defaultModel ?? DEFAULT_MODELS[defaultProvider],
  });
  if (isCancel(defaultModel)) { cancel('Cancelled.'); return null; }
  const modelStr = String(defaultModel ?? '').trim() || DEFAULT_MODELS[defaultProvider];

  // 11. API key — required + validated for OpenRouter, optional for others
  const apiKeyEnv = PROVIDER_API_KEY_ENV[defaultProvider];
  let providerApiKey = existing?.providerApiKey ?? '';
  if (defaultProvider === 'openrouter') {
    const endpoint = PROVIDER_ENDPOINT[defaultProvider] ?? '';
    let validated = false;
    while (!validated) {
      const v = await text({
        message: `${apiKeyEnv} (required)`,
        placeholder: 'sk-or-v1-...',
        initialValue: providerApiKey || existing?.providerApiKey,
        validate: (val) => val?.trim() ? undefined : 'API key required for OpenRouter',
      });
      if (isCancel(v)) { cancel('Cancelled.'); return null; }
      providerApiKey = String(v ?? '').trim();
      process.stdout.write('  Validating key...');
      const result = await checkModelAvailability(endpoint, providerApiKey, modelStr);
      if (result.ok) {
        process.stdout.write(` ✓ valid\n`);
        validated = true;
      } else {
        process.stdout.write(` ✗ ${result.message}\n`);
        const retry = await confirm({ message: 'Try a different key?', initialValue: true });
        if (isCancel(retry)) { cancel('Cancelled.'); return null; }
        if (!retry) { validated = true; }
      }
    }
  } else {
    const v = await text({
      message: `${apiKeyEnv} (${noteEmpty})`,
      placeholder: 'leave blank for local providers',
      initialValue: existing?.providerApiKey,
    });
    if (isCancel(v)) { cancel('Cancelled.'); return null; }
    providerApiKey = String(v ?? '').trim() || existing?.providerApiKey || '';
  }

  // Summary
  const mask = (s: string): string => s ? (s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : '***') : '(skipped)';
  const lines = [
    '',
    '── Summary ──',
    `  Agent name:          ${String(instanceName ?? '')}`,
    `  Install mode:        ${installMode}`,
    `  Security:            ${securityMode}`,
    `  Telegram chat ID:    ${String(telegramChatId ?? '') || '(skipped)'}`,
    `  Telegram token:      ${mask(String(telegramToken ?? ''))}`,
    `  Discord bot token:   ${mask(String(discordBotToken ?? ''))}`,
    `  Provider:            ${defaultProvider}`,
    `  Main model:          ${modelStr}`,
    `  ${apiKeyEnv}:        ${mask(providerApiKey)}`,
    '',
  ];
  process.stdout.write(lines.join('\n'));

  const ok = await confirm({ message: 'Looks good? Write config?', initialValue: true });
  if (isCancel(ok) || !ok) { cancel('Cancelled — no files written.'); return null; }

  outro('Writing config…');

  return {
    installMode: installMode as "simple" | "daemon",
    userName,
    instanceName: String(instanceName ?? '').trim(),
    passphrase: String(passphrase).trim(),
    telegramToken: String(telegramToken ?? '').trim(),
    telegramChatId: String(telegramChatId ?? '').trim(),
    discordBotToken: String(discordBotToken ?? '').trim(),
    discordAppId: String(discordAppId ?? '').trim(),
    discordA2aChannel: String(discordA2aChannel ?? '').trim(),
    defaultProvider: defaultProvider as ProviderChoice,
    defaultModel: modelStr,
    providerApiKey,
    hailMaryModel: modelStr,
    groqApiKey: existing?.groqApiKey ?? '',
    securityMode: String(securityMode ?? 'guardrails'),
    trustMode: true,
  };
}

/** Ping GET <endpoint>/models with the API key. Returns ok=true if the model ID is listed. */
async function checkModelAvailability(endpoint: string, apiKey: string, model: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${endpoint}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, message: `provider returned ${res.status}` };
    const json = await res.json() as { data?: Array<{ id: string }> };
    const ids = (json.data ?? []).map(m => m.id);
    return ids.includes(model)
      ? { ok: true, message: 'available' }
      : { ok: false, message: `"${model}" not found in provider's model list` };
  } catch (err) {
    return { ok: false, message: `check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function validateModelCatalog(model: string, provider: string): Promise<{ ok: boolean; message: string }> {
  try {
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, '..', '..', '..', 'templates', 'config', 'models.json'),
      join(here, '..', '..', 'templates', 'config', 'models.json'),
      join(here, '..', 'templates', 'config', 'models.json'),
      join(resolveReleasesDir(), 'src', 'abtars', 'templates', 'config', 'models.json'),
      join(process.env['HOME'] ?? '', '.abtars', 'config', 'models.json'),
    ];
    let catalog: Record<string, { transports?: string[] }> | null = null;
    for (const p of candidates) {
      try {
        catalog = JSON.parse(await readFile(p, 'utf-8'));
        break;
      } catch { /* try next */ }
    }
    if (!catalog) return { ok: true, message: '' }; // no catalog = skip validation
    const entry = catalog[model];
    if (!entry) return { ok: false, message: `Model "${model}" not found in models.json catalog` };
    const provName = PROVIDER_TRANSPORT_NAME[provider as ProviderChoice] ?? provider;
    if (entry.transports && !entry.transports.includes(provName)) {
      return { ok: false, message: `Model "${model}" not available for provider "${provName}" (supported: ${entry.transports.join(', ')})` };
    }
    return { ok: true, message: '' };
  } catch {
    return { ok: true, message: '' }; // validation error = don't block install
  }
}

function validateNonInteractive(opts: OnboardOptions): WizardAnswers | string {
  if (!opts.acceptRisk) {
    return '--non-interactive requires --accept-risk (you are bypassing safety prompts)';
  }
  if (!opts.instanceName) return '--instance-name is required in non-interactive mode';
  if (!opts.telegramToken) return '--telegram-token is required in non-interactive mode';
  if (!opts.telegramChatId) return '--telegram-chat-id is required in non-interactive mode';
  if (!opts.userName) return '--user-name is required in non-interactive mode';
  if (!opts.passphrase) return '--passphrase is required in non-interactive mode';
  const provider = (opts.defaultProvider ?? 'openrouter') as ProviderChoice;
  if (!VALID_PROVIDERS.includes(provider)) {
    return `--default-provider must be one of: ${VALID_PROVIDERS.join(', ')}`;
  }
  return {
    installMode: 'daemon',
    userName: opts.userName ?? '',
    instanceName: opts.instanceName ?? '',
    passphrase: opts.passphrase ?? '',
    telegramToken: opts.telegramToken ?? '',
    telegramChatId: opts.telegramChatId ?? '',
    discordBotToken: '',
    discordAppId: '',
    discordA2aChannel: opts.discordA2aChannel ?? '',
    defaultProvider: provider,
    defaultModel: opts.defaultModel ?? DEFAULT_MODELS[provider],
    providerApiKey: opts.apiKey ?? '',
    hailMaryModel: '',
    groqApiKey: '',
    securityMode: 'guardrails',
    trustMode: true,
  };
}

async function readExisting(envPath: string): Promise<WizardAnswers | null> {
  try {
    const content = await readFile(envPath, 'utf-8');
    const kv = new Map<string, string>();
    for (const line of content.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && m[1] !== undefined && m[2] !== undefined) kv.set(m[1], m[2]);
    }
    const provider = (kv.get('DEFAULT_PROVIDER') ?? 'openrouter') as ProviderChoice;
    if (!VALID_PROVIDERS.includes(provider)) return null;
    const apiKeyEnv = PROVIDER_API_KEY_ENV[provider];
    return {
      installMode: 'simple',
      userName: kv.get('USER_DISPLAY_NAME') ?? '',
      instanceName: '',
      passphrase: '',
      telegramToken: kv.get('TELEGRAM_BOT_TOKEN') ?? '',
      telegramChatId: kv.get('MAIN_CHAT_ID') ?? '',
      discordBotToken: kv.get('DISCORD_BOT_TOKEN') ?? '',
      discordAppId: kv.get('DISCORD_APP_ID') ?? '',
      discordA2aChannel: kv.get('DISCORD_A2A_CHANNEL_ID') ?? '',
      defaultProvider: provider,
      defaultModel: kv.get('DEFAULT_MODEL') ?? DEFAULT_MODELS[provider],
      providerApiKey: apiKeyEnv ? (kv.get(apiKeyEnv) ?? '') : '',
      hailMaryModel: '',
      groqApiKey: kv.get('GROQ_API_KEY') ?? '',
      securityMode: kv.get('SECURITY_MODE') ?? 'guardrails',
      trustMode: kv.get('TRUST_MODE') === 'true',
    };
  } catch {
    return null;
  }
}

function mergeEnvContent(existing: string, answers: WizardAnswers): string {
  const owned = new Set([
    'MAIN_CHAT_ID',
    'DISCORD_APP_ID', 'DISCORD_A2A_CHANNEL_ID',
    'DEFAULT_PROVIDER', 'DEFAULT_MODEL',
    'HEARTBEAT_INTERVAL_SEC', 'TRUST_MODE',
    'TELEGRAM_ENABLED', 'DISCORD_ENABLED', 'IRC_ENABLED',
    'LOG_LEVEL', 'ACTIVE_MEMORY', 'ENABLE_AGENT_API', 'SELFHEAL_ENABLED',
  ]);
  const keptLines: string[] = [];
  for (const line of existing.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (m && m[1] !== undefined && owned.has(m[1])) continue;
    keptLines.push(line);
  }
  while (keptLines.length > 0 && keptLines[keptLines.length - 1] === '') keptLines.pop();

  const newBlock = [
    '',
    '# --- abtars onboard-managed ---',
    `DEFAULT_PROVIDER=${answers.defaultProvider}`,
    `DEFAULT_MODEL=${answers.defaultModel}`,
  ];
  if (answers.telegramChatId) newBlock.push(`MAIN_CHAT_ID=${answers.telegramChatId}`);
  else if (answers.discordA2aChannel) newBlock.push(`MAIN_CHAT_ID=${answers.discordA2aChannel}`);
  if (answers.discordAppId) newBlock.push(`DISCORD_APP_ID=${answers.discordAppId}`);
  if (answers.discordA2aChannel) newBlock.push(`DISCORD_A2A_CHANNEL_ID=${answers.discordA2aChannel}`);
  newBlock.push(`HEARTBEAT_INTERVAL_SEC=60`);
  newBlock.push(`SECURITY_MODE=${answers.securityMode}`);
  newBlock.push(`TRUST_MODE=${answers.trustMode ? 'true' : 'false'}`);
  newBlock.push(`TELEGRAM_ENABLED=${answers.telegramToken ? 'true' : 'false'}`);
  newBlock.push(`DISCORD_ENABLED=${answers.discordBotToken ? 'true' : 'false'}`);
  newBlock.push(`IRC_ENABLED=false`);
  newBlock.push(`LOG_LEVEL=debug`);
  newBlock.push(`ACTIVE_MEMORY=true`);
  newBlock.push(`ENABLE_AGENT_API=false`);
  newBlock.push(`SELFHEAL_ENABLED=true`);

  return [...keptLines, ...newBlock, ''].join('\n');
}

export async function onboard(opts: OnboardOptions): Promise<number> {
  await printBanner("install");
  const paths = packagePaths('abtars');

  // Install log (#718)
  const { initInstallLog, logInstall, logInstallHeader } = await import("../install-log.js");
  initInstallLog(paths.home);
  logInstallHeader("onboard");
  const _origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    if (typeof chunk === "string" && (chunk.startsWith("✓") || chunk.startsWith("⚠") || chunk.startsWith("•"))) logInstall(chunk.trimEnd());
    return _origWrite(chunk, ...args);
  }) as typeof process.stdout.write;

  let manifest = await readManifest(paths.manifest);
  if (!manifest) {
    // First install — create skeleton + manifest
    const { mkdirSync, existsSync: fileExists, symlinkSync } = await import("node:fs");
    const { chmod } = await import("node:fs/promises");
    for (const d of ["logs", "config", "secret", "skills/core", "skills/self", "skills/custom", "skills/downloaded", "kanban", "state"]) {
      mkdirSync(join(paths.home, d), { recursive: true });
    }
    await chmod(join(paths.home, "secret"), 0o700);
    await chmod(join(paths.home, "config"), 0o700);
    // Ensure ~/.local/bin/ exists and has our binary (symlink from global npm bin if needed)
    const { homedir } = await import("node:os");
    const localBin = join(homedir(), ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const localAbtars = join(localBin, "abtars");
    if (!fileExists(localAbtars)) {
      try {
        const { execSync: ex } = await import("node:child_process");
        const globalBin = ex("npm root -g", { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "ignore"] }).trim().replace(/\/node_modules$/, "");
        const npmAbtars = join(globalBin, "abtars");
        if (fileExists(npmAbtars)) {
          symlinkSync(npmAbtars, localAbtars);
        }
      } catch { /* npm not available — binary already in PATH */ }
    }
    const { hostname } = await import("node:os");
    const { emptyManifest, writeManifest: wm } = await import("../deploy-lib-import.js");
    const mode = process.platform === "darwin" ? "daemon" : "daemon";
    manifest = { ...emptyManifest("abtars", hostname()), installMode: mode } as any;
    await wm(paths.manifest, manifest as any);
    process.stdout.write(`✓ skeleton at ${paths.home}\n✓ install mode: ${mode}\n`);
  }

  const envPath = join(paths.config, '.env');
  const existing = await readExisting(envPath);
  const secretDir = join(paths.home, 'secret');
  const { existsSync: secretExists } = await import('node:fs');
  const hasSecretToken = secretExists(join(secretDir, 'TELEGRAM_BOT_TOKEN')) || secretExists(join(secretDir, 'DISCORD_BOT_TOKEN'));
  const hasUserConfig = existing !== null && (existing.telegramToken || existing.discordBotToken || hasSecretToken);
  if (hasUserConfig && !opts.force) {
    showHintOnce("onboard-reoffer", "Re-running onboard overwrites config. Use --force to confirm, or edit ~/.abtars/config/.env directly.");
    if (opts.nonInteractive) {
      process.stderr.write(`config/.env already configured. Re-run with --force to overwrite.\n`);
      return 3;
    }
  }

  let answers: WizardAnswers | null;
  if (opts.nonInteractive) {
    const result = validateNonInteractive(opts);
    if (typeof result === 'string') {
      process.stderr.write(`error: ${result}\n`);
      return 4;
    }
    answers = result;
    // Validate API key in non-interactive mode — warn but continue
    if (answers.providerApiKey && API_PROVIDERS.has(answers.defaultProvider)) {
      const endpoint = PROVIDER_ENDPOINT[answers.defaultProvider] ?? '';
      const check = await checkModelAvailability(endpoint, answers.providerApiKey, answers.defaultModel);
      if (check.ok) {
        process.stdout.write(`✓ API key valid (${answers.defaultModel} available)\n`);
      } else {
        process.stderr.write(`⚠ API key validation failed: ${check.message}\n  Continuing — fix key in ~/.abtars/config/.env or secret/ later.\n`);
      }
    }
  } else {
    answers = await runInteractive(existing);
    if (answers === null) return 1;
  }

  // Validate model against models.json catalog
  const catalogResult = await validateModelCatalog(answers.defaultModel, answers.defaultProvider);
  if (!catalogResult.ok) {
    if (opts.nonInteractive) {
      if (!opts.force) {
        process.stderr.write(`error: ${catalogResult.message}\n  Use --force to override.\n`);
        return 4;
      }
      process.stderr.write(`⚠ ${catalogResult.message} (--force: continuing)\n`);
    } else {
      const { confirm: cfm, isCancel: isCnl, cancel: cnl } = await import('@clack/prompts');
      process.stderr.write(`⚠ ${catalogResult.message}\n`);
      const cont = await cfm({ message: 'Continue with this model?', initialValue: false });
      if (isCnl(cont) || !cont) { cnl('Cancelled.'); return 1; }
    }
  }

  // Read current .env to preserve operator-added lines.
  let currentContent = '';
  try {
    currentContent = await readFile(envPath, 'utf-8');
  } catch {
    // File doesn't exist yet — install should have seeded it, but guard anyway.
    currentContent = '';
  }

  const next = mergeEnvContent(currentContent, answers);
  await writeFile(envPath, next, { mode: 0o600 });
  process.stdout.write(`\n✓ Wrote ${envPath}\n`);

  // Write secrets to ~/.abtars/secret/ (boot auto-encrypts on first start)
  const secretDirPath = join(paths.home, 'secret');
  await mkdir(secretDirPath, { recursive: true });
  const secrets: Array<[string, string]> = [];
  if (answers.telegramToken) secrets.push(['TELEGRAM_BOT_TOKEN', answers.telegramToken]);
  if (answers.discordBotToken) secrets.push(['DISCORD_BOT_TOKEN', answers.discordBotToken]);
  if (answers.providerApiKey) {
    const providerKeyName = PROVIDER_API_KEY_ENV[answers.defaultProvider];
    if (providerKeyName) secrets.push([providerKeyName, answers.providerApiKey]);
  }
  if (answers.groqApiKey) secrets.push(['GROQ_API_KEY', answers.groqApiKey]);
  for (const [name, value] of secrets) {
    await writeFile(join(secretDirPath, name), value, { mode: 0o600 });
  }
  if (secrets.length > 0) process.stdout.write(`✓ ${secrets.length} secrets → ${secretDirPath}\n`);

  // Write install mode to manifest
  const { writeManifest } = await import('../deploy-lib-import.js');
  const mf = await readManifest(paths.manifest);
  if (mf) await writeManifest(paths.manifest, { ...mf, installMode: answers.installMode });
  process.stdout.write(`✓ install mode: ${answers.installMode}\n`);

  // Write transport.json with selected provider + model
  {
    const transportPath = join(paths.config, 'transport.json');
    let tc: Record<string, unknown> = {};
    try {
      tc = JSON.parse(await readFile(transportPath, 'utf-8'));
    } catch (err) { logAndSwallow("onboard", "op", err); }

    // Seed providers and route-local agents if not already present (v3 schema)
    tc["schemaVersion"] = 3;
    tc["activeRoute"] = "pi-ai";
    if (!tc["providers"]) {
      tc["providers"] = {
        "kiro": { "transport": "acp", "cli": "kiro-cli" },
        "ollama": { "transport": "api", "endpoint": "http://localhost:11434/v1" },
        "openrouter": { "transport": "api", "endpoint": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY" },
      };
    }
    if (!tc["routes"]) {
      const provName = PROVIDER_TRANSPORT_NAME[answers.defaultProvider] ?? answers.defaultProvider;
      tc["routes"] = {
        "pi-ai": {
          "agents": {
            "main": { "model": answers.defaultModel, "provider": provName },
            "dreamy": { "model": answers.defaultModel, "provider": provName },
            "browsie": { "model": answers.defaultModel, "provider": provName },
            "cody": { "model": answers.defaultModel, "provider": provName },
          },
          "fallbacks": [],
        },
      };
    }
    if (answers.hailMaryModel) {
      const provName = PROVIDER_TRANSPORT_NAME[answers.defaultProvider] ?? answers.defaultProvider;
      tc["hailMary"] = { route: "acp", model: answers.hailMaryModel, provider: provName };
    }

    await writeFile(transportPath, JSON.stringify(tc, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(`✓ transport.json → ${transportPath}\n`);
  }

  // Write users.json (always — onboard has the real chat ID)
  {
    const usersPath = join(paths.config, 'users.json');
    const userId = answers.userName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
    const platforms: Record<string, unknown> = {};
    if (answers.telegramChatId) platforms["telegram"] = parseInt(answers.telegramChatId, 10) || answers.telegramChatId;
    if (answers.discordAppId) platforms["discord"] = answers.discordAppId;
    const users = {
      users: [{
        userId,
        displayName: answers.userName || userId,
        role: "master",
        maxClass: 3,
        tools: ["all"],
        platforms,
        allowedChats: [],
      }],
    };
    await writeFile(usersPath, JSON.stringify(users, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(`✓ users.json → ${usersPath}\n`);

    // #1009: Write instance name to peers.json
    const peersPath = join(paths.config, 'peers.json');
    let peersJson: Record<string, unknown> = { self: { name: "default" }, peers: {} };
    try { peersJson = JSON.parse(await readFile(peersPath, 'utf-8')); } catch { /* missing — use default */ }
    if (!peersJson.self || typeof peersJson.self !== 'object') peersJson.self = {};
    (peersJson.self as Record<string, unknown>).name = answers.instanceName || answers.userName.toLowerCase().replace(/[^a-z0-9-]/g, '') || 'default';
    await writeFile(peersPath, JSON.stringify(peersJson, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(`✓ peers.json (self.name: ${(peersJson.self as Record<string, unknown>).name}) → ${peersPath}\n`);

    // Copy models.json (model metadata for context window, cost, rank)
    const modelsPath = join(paths.config, 'models.json');
    const { existsSync: modelsExists, copyFileSync: modelsCopy } = await import('node:fs');
    if (!modelsExists(modelsPath)) {
      const { fileURLToPath } = await import('node:url');
      const here = dirname(fileURLToPath(import.meta.url));
      const modelsCandidates = [
        join(here, '..', '..', '..', 'config', 'models.json'),
        join(here, '..', '..', 'config', 'models.json'),
        join(resolveReleasesDir(), 'src', 'abtars', 'config', 'models.json'),
      ];
      for (const p of modelsCandidates) {
        if (modelsExists(p)) { modelsCopy(p, modelsPath); process.stdout.write(`✓ models.json → ${modelsPath}\n`); break; }
      }
    }

    // Check abmind encryption compatibility
    try {
      const { abmindHome } = await import("../../paths.js");
      const manifestPath = join(abmindHome(), 'manifest.json');
      const manifest = JSON.parse((await import('node:fs')).readFileSync(manifestPath, 'utf-8'));
      if (manifest.encryptionUser && manifest.encryptionUser !== answers.userName) {
        process.stdout.write(`⚠️  abmind encryption uses name '${manifest.encryptionUser}' but you entered '${answers.userName}'. Backup restore will need the encryption name ('${manifest.encryptionUser}').\n`);
      }
    } catch { /* no abmind or no manifest — fine */ }
  }

  // Initialize passphrase-based encryption — generate abtars.key (#1166)
  if (answers.passphrase && answers.userName) {
    try {
      const master = deriveFromPassphrase(answers.passphrase, answers.userName);
      const keyPath = join(paths.home, "config", "abtars.key");
      writeKeyFile(keyPath, master);
      writeKeyVerify(keyPath, deriveKey(master));
      process.stdout.write(`✓ abtars.key derived from passphrase\n`);
    } catch (err) {
      process.stdout.write(`⚠ Key init failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // Seed default tasks (#383) — morning greeting + midnight backup
  if (answers.telegramChatId) {
    await seedDefaultTasks(answers.telegramChatId, paths.home);
  }

  // Seed default agent-api rules
  process.stdout.write(`\n💡 To edit providers, agents, hailMary, fallback chains — edit:\n   ${join(paths.config, 'transport.json')}\n   Docs: https://aksika.github.io/abtars/\n`);

  // Run update (clone source, build, deploy, start bridge)
  process.stdout.write(`\nRunning abtars update...\n`);
  const { update } = await import("./update.js");
  return await update({ source: opts.source ?? "alpha", localDir: opts.localDir, skipFreshness: true, allowAbmindMismatch: false });
}

// ── Default task seeding (#383) ─────────────────────────────────────────────

/**
 * Seed default tasks (#383) via copy — skipped if tasks.json
 * already exists. Called from onboard after .env is persisted so chatId
 * is available.
 */
async function seedDefaultTasks(_chatId: string, abtarsHome: string): Promise<void> {
  const { existsSync, mkdirSync, copyFileSync } = await import('node:fs');
  const tasksJson = join(abtarsHome, 'tasks', 'tasks.json');
  if (existsSync(tasksJson)) {
    process.stdout.write(`• tasks.json exists — skipping default-task seed\n`);
    return;
  }

  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', '..', 'templates', 'tasks', 'tasks.json'),
    join(here, '..', '..', 'templates', 'tasks', 'tasks.json'),
    join(resolveReleasesDir(), 'src', 'abtars', 'templates', 'tasks', 'tasks.json'),
    join(resolveReleasesDir(), 'templates', 'tasks', 'tasks.json'),
  ];
  let templatePath: string | null = null;
  for (const p of candidates) {
    if (existsSync(p)) { templatePath = p; break; }
  }
  if (!templatePath) {
    return;
  }

  mkdirSync(join(abtarsHome, 'tasks'), { recursive: true });
  copyFileSync(templatePath, tasksJson);
  process.stdout.write(`✓ default tasks seeded\n`);
}
