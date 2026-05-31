/**
 * `abtars onboard` — first-time interactive configuration wizard
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
 *     edits config/.env directly post-onboard)
 */

import { logAndSwallow } from "../../components/log-and-swallow.js";
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagePaths, readManifest } from '../deploy-lib-import.js';
import { showHintOnce } from '../../components/hints.js';

export interface OnboardOptions {
  readonly nonInteractive: boolean;
  readonly acceptRisk: boolean;
  readonly telegramToken?: string;
  readonly telegramChatId?: string;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly discordA2aChannel?: string;
  readonly force: boolean;
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
  openrouter: 'google/gemini-2.5-flash',
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
  readonly installMode: "simple" | "supervised" | "supervised-daemon";
  readonly agentName: string;
  readonly userName: string;
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
  readonly bedTime: string;
  readonly wakeTime: string;
  readonly groqApiKey: string;
  readonly embeddingEnabled: boolean;
  readonly trustMode: boolean;
}

async function runInteractive(existing: WizardAnswers | null): Promise<WizardAnswers | null> {
  // Dynamic import — @clack/prompts is the only dep introduced in Phase 3;
  // keep it off the critical path for Phase 1-2 subcommands.
  const { intro, outro, text, select, confirm, isCancel, cancel } = await import('@clack/prompts');

  intro('abtars onboard — first-time setup');
  const noteEmpty = 'press Enter to skip';

  // 1. Deployment mode
  const installMode = await select<"simple" | "supervised" | "supervised-daemon">({
    message: 'Deployment mode',
    options: [
      { value: 'simple', label: 'simple — laptop/dev, start manually' },
      { value: 'supervised', label: 'supervised — 24/7 host, user-scope auto-restart (recommended: macOS)' },
      { value: 'supervised-daemon', label: 'supervised-daemon — system-scope service (recommended: Linux)' },
    ],
    initialValue: existing?.installMode ?? 'simple',
  });
  if (isCancel(installMode)) { cancel('Cancelled.'); return null; }

  // 1b. Agent name
  const agentName = await text({
    message: 'Agent name (identity for this deployment)',
    placeholder: 'e.g. MyAgent, HomeBot',
    initialValue: '',
  });
  if (isCancel(agentName)) { cancel('Cancelled.'); return null; }

  // 1c. User name (for personal greeting + encryption salt)
  const userName = await text({
    message: 'Your name (used for encryption — same on all machines)',
    placeholder: 'e.g. aksika',
    initialValue: existing?.userName ?? '',
  });
  if (isCancel(userName)) { cancel('Cancelled.'); return null; }

  // 1d. Passphrase (for memory encryption)
  const passphrase = await text({
    message: 'Encryption passphrase (protects memories + secrets)',
    placeholder: 'min 6 chars — remember this!',
    validate: (v) => (v && v.length >= 6) ? undefined : 'min 6 characters',
  });
  if (isCancel(passphrase)) { cancel('Cancelled.'); return null; }

  // 2-3. Telegram (optional)
  const telegramToken = await text({
    message: `Telegram bot token (from @BotFather, ${noteEmpty})`,
    placeholder: '1234567890:AA...',
    initialValue: existing?.telegramToken,
    validate: (v) => (!v || v.trim() === '' || v.includes(':')) ? undefined : 'expected format "<id>:<secret>" or empty',
  });
  if (isCancel(telegramToken)) { cancel('Cancelled.'); return null; }

  const telegramChatId = await text({
    message: `Primary Telegram chat ID (${noteEmpty})`,
    placeholder: '123456789',
    initialValue: existing?.telegramChatId,
    validate: (v) => (!v || v.trim() === '' || /^-?\d+$/.test(v.trim())) ? undefined : 'expected numeric chat id or empty',
  });
  if (isCancel(telegramChatId)) { cancel('Cancelled.'); return null; }

  // 4-6. Discord (all optional)
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
    validate: (v) => (!v || v.trim() === '' || /^\d{10,20}$/.test(v.trim())) ? undefined : 'expected Discord snowflake or empty',
  });
  if (isCancel(discordAppId)) { cancel('Cancelled.'); return null; }

  const discordA2aChannel = await text({
    message: `Discord allowed channel ID (${noteEmpty})`,
    placeholder: '987654321098765432',
    initialValue: existing?.discordA2aChannel,
    validate: (v) => (!v || v.trim() === '' || /^\d{10,20}$/.test(v.trim())) ? undefined : 'expected Discord snowflake or empty',
  });
  if (isCancel(discordA2aChannel)) { cancel('Cancelled.'); return null; }

  // 7. Provider
  const defaultProvider = await select<ProviderChoice>({
    message: 'Default transport provider',
    options: [
      { value: 'openrouter', label: 'openrouter — many models via API key' },
      { value: 'anthropic', label: 'anthropic — Claude API (direct)' },
      { value: 'openai', label: 'openai — GPT API (direct)' },
      { value: 'ollama', label: 'ollama — local/cloud Ollama endpoint' },
      { value: 'kiro', label: 'kiro — Kiro CLI (free or paid; tier via model)' },
      { value: 'gemini', label: 'gemini — Gemini CLI (free or paid; tier via model)' },
    ],
    initialValue: existing?.defaultProvider ?? 'kiro',
  });
  if (isCancel(defaultProvider)) { cancel('Cancelled.'); return null; }

  // 8. Default model
  const defaultModel = await text({
    message: `Default model (for ${defaultProvider})`,
    placeholder: DEFAULT_MODELS[defaultProvider],
    initialValue: existing?.defaultModel ?? DEFAULT_MODELS[defaultProvider],
  });
  if (isCancel(defaultModel)) { cancel('Cancelled.'); return null; }

  // 9. API key — every provider now has an env var; always ask, allow skip
  const apiKeyEnv = PROVIDER_API_KEY_ENV[defaultProvider];
  let providerApiKey = existing?.providerApiKey ?? '';
  {
    const v = await text({
      message: `${apiKeyEnv} (${noteEmpty})`,
      placeholder: existing?.providerApiKey ? '(keep existing)' : 'sk-or-v1-... or leave blank',
      initialValue: existing?.providerApiKey,
    });
    if (isCancel(v)) { cancel('Cancelled.'); return null; }
    providerApiKey = String(v ?? '').trim() || existing?.providerApiKey || '';
  }

  // 10. Availability check
  const modelStr = String(defaultModel).trim() || DEFAULT_MODELS[defaultProvider];
  if (API_PROVIDERS.has(defaultProvider) && providerApiKey) {
    const check = await confirm({ message: 'Check availability (GET /v1/models)?', initialValue: true });
    if (isCancel(check)) { cancel('Cancelled.'); return null; }
    if (check) {
      const endpoint = PROVIDER_ENDPOINT[defaultProvider] ?? '';
      const result = await checkModelAvailability(endpoint, providerApiKey, modelStr);
      process.stdout.write(result.ok ? `✓ ${modelStr} available on ${defaultProvider}\n` : `⚠️  ${result.message}\n`);
    }
  }

  // 11. Ultimate fallback (hailMary)
  const hailMary = await text({
    message: `Ultimate fallback model — hailMary (${noteEmpty}; uses same provider + key as above)`,
    placeholder: 'google/gemini-2.5-flash',
    initialValue: existing?.hailMaryModel ?? 'google/gemini-2.5-flash',
  });
  if (isCancel(hailMary)) { cancel('Cancelled.'); return null; }
  const hailMaryModel = String(hailMary ?? '').trim();

  if (hailMaryModel && API_PROVIDERS.has(defaultProvider) && providerApiKey) {
    const check = await confirm({ message: `Check hailMary availability (${hailMaryModel})?`, initialValue: true });
    if (isCancel(check)) { cancel('Cancelled.'); return null; }
    if (check) {
      const endpoint = PROVIDER_ENDPOINT[defaultProvider] ?? '';
      const result = await checkModelAvailability(endpoint, providerApiKey, hailMaryModel);
      process.stdout.write(result.ok ? `✓ ${hailMaryModel} available\n` : `⚠️  ${result.message}\n`);
    }
  }

  // 12. Sleep schedule + voice + trust mode
  const bedTime = await text({
    message: `Bed time HH:MM — daily sleep trigger (${noteEmpty} for default 0:30)`,
    placeholder: '0:30',
    initialValue: existing?.bedTime,
    validate: (v) => (!v || /^\d{1,2}:\d{2}$/.test(v.trim())) ? undefined : 'expected H:MM format',
  });
  if (isCancel(bedTime)) { cancel('Cancelled.'); return null; }

  const wakeTime = await text({
    message: `Wake time HH:MM (${noteEmpty} for default 7:00)`,
    placeholder: '7:00',
    initialValue: existing?.wakeTime,
    validate: (v) => (!v || /^\d{1,2}:\d{2}$/.test(v.trim())) ? undefined : 'expected H:MM format',
  });
  if (isCancel(wakeTime)) { cancel('Cancelled.'); return null; }

  const groqApiKey = await text({
    message: `GROQ_API_KEY for voice-note transcription (${noteEmpty})`,
    placeholder: existing?.groqApiKey ? '(keep existing)' : 'gsk_...',
    initialValue: existing?.groqApiKey,
  });
  if (isCancel(groqApiKey)) { cancel('Cancelled.'); return null; }

  // 12b. Embeddings
  const embeddingEnabled = await confirm({
    message: 'Enable memory embeddings? (requires ollama + 274MB model)',
    initialValue: existing?.embeddingEnabled ?? false,
  });
  if (isCancel(embeddingEnabled)) { cancel('Cancelled.'); return null; }

  if (embeddingEnabled) {
    const { checkEmbeddingHealth } = await import('abmind');
    const health = await checkEmbeddingHealth();
    if (!health.reachable) {
      process.stdout.write(`\n⚠️  ollama not found. Install with:\n   curl -fsSL https://ollama.com/install.sh | sh\n   Then re-run onboard.\n\n`);
    } else if (!health.modelPulled) {
      const pull = await confirm({ message: 'Pull nomic-embed-text (274MB)?', initialValue: true });
      if (!isCancel(pull) && pull) {
        process.stdout.write('Pulling nomic-embed-text...\n');
        const { spawnSync } = await import('node:child_process');
        spawnSync('ollama', ['pull', 'nomic-embed-text'], { stdio: 'inherit' });
      }
    } else {
      process.stdout.write('✓ ollama + nomic-embed-text ready\n');
    }
  }

  const trustMode = await confirm({
    message: 'TRUST_MODE — auto-approve all permission requests from the agent? (recommended for personal/automated use)',
    initialValue: existing?.trustMode ?? true,
  });
  if (isCancel(trustMode)) { cancel('Cancelled.'); return null; }

  // 13. Summary + confirmation
  const mask = (s: string): string => s ? (s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : '***') : '(skipped)';
  const lines = [
    '',
    '── Summary ──',
    `  Deployment mode:     ${installMode}`,
    `  Your name:           ${String(userName ?? '') || '(skipped)'}`,
    `  Telegram token:      ${mask(String(telegramToken ?? ''))}`,
    `  Telegram chat ID:    ${String(telegramChatId ?? '') || '(skipped)'}`,
    `  Discord bot token:   ${mask(String(discordBotToken ?? ''))}`,
    `  Discord app ID:      ${String(discordAppId ?? '') || '(skipped)'}`,
    `  Discord channel ID:  ${String(discordA2aChannel ?? '') || '(skipped)'}`,
    `  Provider:            ${defaultProvider}`,
    `  Default model:       ${modelStr}`,
    `  ${apiKeyEnv}:        ${mask(providerApiKey)}`,
    `  hailMary model:      ${hailMaryModel || '(skipped)'}`,
    `  Bed time:            ${String(bedTime ?? '') || '(default 0:30)'}`,
    `  Wake time:           ${String(wakeTime ?? '') || '(default 7:00)'}`,
    `  GROQ_API_KEY:        ${mask(String(groqApiKey ?? ''))}`,
    `  Embeddings:          ${embeddingEnabled ? 'enabled' : 'disabled'}`,
    `  Trust mode:          ${trustMode ? 'true (auto-approve)' : 'false (prompt user)'}`,
    '',
  ];
  process.stdout.write(lines.join('\n'));

  const ok = await confirm({ message: 'Looks good? Write config?', initialValue: true });
  if (isCancel(ok) || !ok) { cancel('Cancelled — no files written.'); return null; }

  outro('Writing config…');

  return {
    installMode: installMode as "simple" | "supervised" | "supervised-daemon",
    agentName: String(agentName ?? '').trim(),
    userName: String(userName ?? '').trim(),
    passphrase: String(passphrase ?? ''),
    telegramToken: String(telegramToken ?? '').trim(),
    telegramChatId: String(telegramChatId ?? '').trim(),
    discordBotToken: String(discordBotToken ?? '').trim(),
    discordAppId: String(discordAppId ?? '').trim(),
    discordA2aChannel: String(discordA2aChannel ?? '').trim(),
    defaultProvider: defaultProvider as ProviderChoice,
    defaultModel: modelStr,
    providerApiKey,
    hailMaryModel,
    bedTime: String(bedTime ?? '').trim(),
    wakeTime: String(wakeTime ?? '').trim(),
    groqApiKey: String(groqApiKey ?? '').trim() || existing?.groqApiKey || '',
    embeddingEnabled: embeddingEnabled === true,
    trustMode: trustMode === true,
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

function validateNonInteractive(opts: OnboardOptions): WizardAnswers | string {
  if (!opts.acceptRisk) {
    return '--non-interactive requires --accept-risk (you are bypassing safety prompts)';
  }
  const provider = (opts.defaultProvider ?? 'openrouter') as ProviderChoice;
  if (!VALID_PROVIDERS.includes(provider)) {
    return `--default-provider must be one of: ${VALID_PROVIDERS.join(', ')}`;
  }
  return {
    installMode: 'supervised',
    agentName: '',
    userName: '',
    passphrase: '',
    telegramToken: opts.telegramToken ?? '',
    telegramChatId: opts.telegramChatId ?? '',
    discordBotToken: '',
    discordAppId: '',
    discordA2aChannel: opts.discordA2aChannel ?? '',
    defaultProvider: provider,
    defaultModel: opts.defaultModel ?? DEFAULT_MODELS[provider],
    providerApiKey: '',
    hailMaryModel: '',
    bedTime: '',
    wakeTime: '',
    groqApiKey: '',
    embeddingEnabled: false,
    trustMode: false,
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
      agentName: '',
      userName: kv.get('USER_DISPLAY_NAME') ?? '',
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
      bedTime: kv.get('BED_TIME') ?? '',
      wakeTime: kv.get('WAKE_TIME') ?? '',
      groqApiKey: kv.get('GROQ_API_KEY') ?? '',
      embeddingEnabled: kv.get('EMBEDDING_ENABLED') === 'true',
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
    'BED_TIME', 'WAKE_TIME', 'HEARTBEAT_INTERVAL_SEC', 'EMBEDDING_ENABLED', 'TRUST_MODE',
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
  if (answers.bedTime) newBlock.push(`BED_TIME=${answers.bedTime}`);
  if (answers.wakeTime) newBlock.push(`WAKE_TIME=${answers.wakeTime}`);
  newBlock.push(`HEARTBEAT_INTERVAL_SEC=300`);
  newBlock.push(`EMBEDDING_ENABLED=${answers.embeddingEnabled ? 'true' : 'false'}`);
  newBlock.push(`TRUST_MODE=${answers.trustMode ? 'true' : 'false'}`);

  return [...keptLines, ...newBlock, ''].join('\n');
}

export async function onboard(opts: OnboardOptions): Promise<number> {
  const paths = packagePaths('abtars');
  const manifest = await readManifest(paths.manifest);
  if (!manifest) {
    process.stderr.write(
      `Not installed yet. Run 'abtars install' first.\n(Manifest not found at ${paths.manifest}.)\n`,
    );
    return 2;
  }

  const envPath = join(paths.config, '.env');
  const existing = await readExisting(envPath);
  if (existing !== null && !opts.force) {
    showHintOnce("onboard-reoffer", "Re-running onboard overwrites config. Use --force to confirm, or edit ~/.abtars/config/.env directly.");
    if (opts.nonInteractive) {
      process.stderr.write(`config/.env already configured. Re-run with --force to overwrite.\n`);
      return 3;
    }
    // Interactive: we'll pre-fill and let the user edit.
  }

  let answers: WizardAnswers | null;
  if (opts.nonInteractive) {
    const result = validateNonInteractive(opts);
    if (typeof result === 'string') {
      process.stderr.write(`error: ${result}\n`);
      return 4;
    }
    answers = result;
  } else {
    answers = await runInteractive(existing);
    if (answers === null) return 1;
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

    // Seed providers and agents if not already present
    if (!tc["providers"]) {
      tc["providers"] = {
        "kiro": { "transport": "acp", "cli": "kiro-cli" },
        "ollama": { "transport": "api", "endpoint": "http://localhost:11434/v1" },
        "openrouter": { "transport": "api", "endpoint": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY" },
      };
    }
    if (!tc["agents"]) {
      const provName = PROVIDER_TRANSPORT_NAME[answers.defaultProvider] ?? answers.defaultProvider;
      tc["agents"] = {
        "professor": { "model": answers.defaultModel, "provider": provName },
        "dreamy": { "model": answers.defaultModel, "provider": provName },
        "browsie": { "model": answers.defaultModel, "provider": provName },
        "coding": { "model": answers.defaultModel, "provider": provName },
      };
    }
    if (answers.hailMaryModel) {
      const provName = PROVIDER_TRANSPORT_NAME[answers.defaultProvider] ?? answers.defaultProvider;
      tc["hailMary"] = { model: answers.hailMaryModel, provider: provName };
    }

    await writeFile(transportPath, JSON.stringify(tc, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(`✓ transport.json → ${transportPath}\n`);
  }

  // Write users.json
  {
    const usersPath = join(paths.config, 'users.json');
    const { existsSync: usersExist } = await import('node:fs');
    if (!usersExist(usersPath)) {
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
    }
  }

  // Seed abmind user_profile.md with user's name (if abmind is in use and file doesn't exist)
  if (answers.userName) {
    const abmindHome = process.env['ABMIND_HOME'] ?? join(dirname(paths.home), '.abmind');
    const profileDir = join(abmindHome, 'memory', 'core');
    const profilePath = join(profileDir, 'user_profile.md');
    const { existsSync: profileExists } = await import('node:fs');
    if (!profileExists(profilePath)) {
      await mkdir(profileDir, { recursive: true });
      await writeFile(profilePath, `# User Profile\n\nName: ${answers.userName}\n`, { mode: 0o600 });
      process.stdout.write(`✓ user_profile.md → ${profilePath}\n`);
    }
  }

  // Initialize passphrase-based encryption (#607)
  if (answers.passphrase && answers.userName) {
    try {
      const { deriveFromPassphrase, writeKeyVerify } = await import("abmind");
      const { writeToKeyring } = await import("abmind");
      const key = deriveFromPassphrase(answers.passphrase, answers.userName);
      writeKeyVerify(key);
      const stored = writeToKeyring(answers.passphrase);
      process.stdout.write(`✓ Encryption key derived from passphrase${stored ? " (stored in keyring)" : ""}\n`);
    } catch (err) {
      process.stdout.write(`⚠ Key init failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // Seed default tasks (#383) — morning greeting + midnight backup
  if (answers.telegramChatId) {
    await seedDefaultTasks(answers.telegramChatId, paths.home);
  }

  // Seed default agent-api rules
  const agentsDir = join(paths.home, 'agents');
  const agentRulesPath = join(agentsDir, 'default.md');
  const { existsSync: agentRulesExists } = await import('node:fs');
  if (!agentRulesExists(agentRulesPath)) {
    await mkdir(agentsDir, { recursive: true });
    const bundledPath = join(dirname(fileURLToPath(import.meta.url)), 'agents', 'default.md');
    const fallbackPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents', 'default.md');
    let content = '# Agent-to-Agent API\n\n<!-- See docs for configuration -->\n';
    try { content = (await readFile(bundledPath, 'utf-8')); } catch {
      try { content = (await readFile(fallbackPath, 'utf-8')); } catch { /* use default */ }
    }
    await writeFile(agentRulesPath, content);
    process.stdout.write(`✓ agents/default.md → ${agentRulesPath}\n`);
  }

  process.stdout.write(`\n💡 To edit providers, agents, hailMary, fallback chains — edit:\n   ${join(paths.config, 'transport.json')}\n   Docs: https://github.com/aksika/abtars/blob/main/docs/install.md\n`);

  // Skip the build+start automation in non-interactive mode (scripts expect to do it themselves)
  if (opts.nonInteractive) {
    process.stdout.write(`\nNext: 'abtars update' to build, then start the bridge.\n`);
    return 0;
  }

  // ── Auto-run: abtars update ──
  // Only auto-update if we're inside the abtars repo (git repo with package.json)
  const { existsSync } = await import('node:fs');
  const inRepo = existsSync(join(process.cwd(), '.git')) && existsSync(join(process.cwd(), 'package.json'));
  if (!inRepo) {
    process.stdout.write(`\nNext: cd into the abtars repo and run 'abtars update' to build and activate.\n`);
    return 0;
  }
  process.stdout.write(`\n── Running 'abtars update' ──\n`);
  const { update } = await import('./update.js');
  const updRc = await update({ source: 'local', fromLocal: true, allowAbmindMismatch: false });
  if (updRc !== 0) {
    process.stderr.write(`\n⚠️  'abtars update' exited with code ${updRc}. Fix and re-run manually.\n`);
    return updRc;
  }

  // ── Auto-run: abmind install + update ──
  process.stdout.write(`\n── Running 'abmind install && abmind update' ──\n`);
  const { spawn } = await import('node:child_process');
  const runAbmind = (sub: 'install' | 'update'): Promise<number> => new Promise((resolve) => {
    // abmind is a sibling package under the workspace — resolve relative to repo root's parent.
    const abmindRepo = join(process.cwd(), '..', 'abmind');
    const cliPath = join(abmindRepo, 'dist', 'cli', `abmind-${sub}.js`);
    const child = spawn('node', [cliPath], { stdio: 'inherit', cwd: abmindRepo });
    child.on('exit', (code) => resolve(code ?? 1));
  });
  const abInstallRc = await runAbmind('install');
  if (abInstallRc === 0) {
    const abUpdateRc = await runAbmind('update');
    if (abUpdateRc !== 0) process.stderr.write(`\n⚠️  'abmind update' exited with code ${abUpdateRc}.\n`);
  } else {
    process.stderr.write(`\n⚠️  'abmind install' exited with code ${abInstallRc}. Skipping abmind update.\n`);
  }

  // ── Start commands — print + ask to run ──
  const { confirm } = await import('@clack/prompts');
  const startCmds: string[] = [];
  if (answers.installMode === 'simple') {
    startCmds.push(`~/.abtars/abtars.sh --all`);
  } else {
    if (process.platform === 'darwin') {
      startCmds.push(`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.abtars.watchdog.plist`);
    } else if (process.platform === 'linux') {
      startCmds.push(`systemctl --user daemon-reload`);
      startCmds.push(`systemctl --user enable --now abtars-watchdog`);
    }
  }

  process.stdout.write(`\n── Start the bridge ──\n`);
  for (const cmd of startCmds) {
    const run = await confirm({ message: `Run: ${cmd}`, initialValue: true });
    if (run === true) {
      await new Promise<void>((resolve) => {
        const child = spawn('bash', ['-lc', cmd], { stdio: 'inherit' });
        child.on('exit', () => resolve());
      });
    } else {
      process.stdout.write(`  → manual: ${cmd}\n`);
    }
  }

  process.stdout.write(`\n✓ Onboarding complete.\n`);
  return 0;
}

// ── Default task seeding (#383) ─────────────────────────────────────────────

interface TaskTemplateEntry {
  readonly id?: string;
  readonly title?: string;
  readonly message: string;
  readonly schedule: string;
  readonly type: "task" | "reminder";
  readonly executor: "agent" | "script";
  readonly maxRunsPerDay?: number;
}

/**
 * Seed default tasks (#383) via `abtars-task add` — skipped if tasks.json
 * already exists. Called from onboard after .env is persisted so chatId
 * is available.
 */
async function seedDefaultTasks(chatId: string, abtarsHome: string): Promise<void> {
  const { existsSync } = await import('node:fs');
  const tasksJson = join(abtarsHome, 'state', 'tasks.json');
  if (existsSync(tasksJson)) {
    process.stdout.write(`• tasks.json exists — skipping default-task seed\n`);
    return;
  }

  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  // onboard.ts is at src/cli/commands/onboard.ts or dist/cli/commands/onboard.js
  // tasks.default.json lives at repo root — three levels up.
  const candidates = [
    join(here, '..', '..', '..', 'tasks.default.json'),
    join(here, '..', '..', 'tasks.default.json'),
  ];
  let templatePath: string | null = null;
  for (const p of candidates) {
    if (existsSync(p)) { templatePath = p; break; }
  }
  if (!templatePath) {
    process.stdout.write(`• tasks.default.json not found — skipping default-task seed\n`);
    return;
  }

  let template: TaskTemplateEntry[];
  try {
    const raw = await readFile(templatePath, 'utf-8');
    template = JSON.parse(raw) as TaskTemplateEntry[];
  } catch (err) {
    process.stdout.write(`• Failed to read tasks.default.json: ${err instanceof Error ? err.message : String(err)}\n`);
    return;
  }

  const { spawnSync } = await import('node:child_process');
  let seeded = 0;
  for (const entry of template) {
    const args = [
      'add',
      '--schedule', entry.schedule,
      '--message', entry.message,
      '--chat-id', chatId,
      '--type', entry.type,
      '--executor', entry.executor,
    ];
    if (entry.id) args.push('--id', entry.id);
    if (entry.title) args.push('--title', entry.title);
    if (entry.maxRunsPerDay) args.push('--max-runs-per-day', String(entry.maxRunsPerDay));
    const result = spawnSync('abtars-task', args, {
      encoding: 'utf-8',
      env: { ...process.env, ABTARS_HOME: abtarsHome },
    });
    if (result.status === 0) {
      seeded++;
    } else {
      const err = result.error?.message ?? result.stderr?.trim() ?? result.stdout?.trim() ?? `exit ${result.status}`;
      process.stdout.write(`  ⚠️ failed to seed task "${entry.message.slice(0, 40)}": ${err}\n`);
    }
  }
  if (seeded > 0) {
    process.stdout.write(`✓ seeded ${seeded} default task${seeded === 1 ? '' : 's'}\n`);
  }
}
