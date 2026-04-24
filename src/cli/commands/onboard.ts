/**
 * `agentbridge onboard` — first-time interactive configuration wizard
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

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packagePaths, readManifest } from '../deploy-lib-import.js';

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

type ProviderChoice = 'openrouter' | 'anthropic' | 'openai';

const VALID_PROVIDERS: readonly ProviderChoice[] = ['openrouter', 'anthropic', 'openai'];
const DEFAULT_MODELS: Record<ProviderChoice, string> = {
  openrouter: 'z-ai/glm-4.6',
  anthropic: 'claude-sonnet-4-5-20250929',
  openai: 'gpt-4o',
};

interface WizardAnswers {
  readonly telegramToken: string;
  readonly telegramChatId: string;
  readonly defaultProvider: ProviderChoice;
  readonly defaultModel: string;
  readonly providerApiKey: string;
  readonly discordA2aChannel: string | null;
  readonly installMode: "simple" | "supervised";
}

const PROVIDER_API_KEY_ENV: Record<ProviderChoice, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

async function runInteractive(existing: WizardAnswers | null): Promise<WizardAnswers | null> {
  // Dynamic import — @clack/prompts is the only dep introduced in Phase 3;
  // keep it off the critical path for Phase 1-2 subcommands.
  const { intro, outro, text, select, confirm, isCancel, cancel } = await import('@clack/prompts');

  intro('agentbridge onboard — first-time setup');

  const telegramToken = await text({
    message: 'Telegram bot token (from @BotFather)',
    placeholder: existing?.telegramToken ?? '1234567890:AA...',
    initialValue: existing?.telegramToken,
    validate: (v) => {
      if (v === undefined || v.trim() === '') return 'required';
      return v.includes(':') ? undefined : 'expected format "<id>:<secret>"';
    },
  });
  if (isCancel(telegramToken)) {
    cancel('Cancelled.');
    return null;
  }

  const telegramChatId = await text({
    message: 'Primary Telegram chat ID (the user who talks to the bot)',
    placeholder: existing?.telegramChatId ?? '123456789',
    initialValue: existing?.telegramChatId,
    validate: (v) => {
      if (v === undefined) return 'required';
      return /^-?\d+$/.test(v.trim()) ? undefined : 'expected a numeric chat id';
    },
  });
  if (isCancel(telegramChatId)) {
    cancel('Cancelled.');
    return null;
  }

  const defaultProvider = await select<ProviderChoice>({
    message: 'Default transport provider',
    options: [
      { value: 'openrouter', label: 'OpenRouter (many models, one API key)' },
      { value: 'anthropic', label: 'Anthropic (direct)' },
      { value: 'openai', label: 'OpenAI (direct)' },
    ],
    initialValue: existing?.defaultProvider ?? 'openrouter',
  });
  if (isCancel(defaultProvider)) {
    cancel('Cancelled.');
    return null;
  }

  const defaultModel = await text({
    message: `Default model (for ${defaultProvider})`,
    placeholder: DEFAULT_MODELS[defaultProvider],
    initialValue: existing?.defaultModel ?? DEFAULT_MODELS[defaultProvider],
  });
  if (isCancel(defaultModel)) {
    cancel('Cancelled.');
    return null;
  }

  const providerApiKey = await text({
    message: `${PROVIDER_API_KEY_ENV[defaultProvider as ProviderChoice]} (for ${defaultProvider})`,
    placeholder: existing?.providerApiKey ? '(keep existing)' : 'sk-or-v1-...',
    initialValue: existing?.providerApiKey,
    validate: (v) => {
      if ((v === undefined || v.trim() === '') && !existing?.providerApiKey) return 'required — API will not work without it';
      return undefined;
    },
  });
  if (isCancel(providerApiKey)) {
    cancel('Cancelled.');
    return null;
  }

  const installMode = await select<"simple" | "supervised">({
    message: 'Deployment mode',
    options: [
      { value: 'simple', label: 'simple — laptop/WSL, no OS supervisor (start manually)' },
      { value: 'supervised', label: 'supervised — 24/7 host, launchd/systemd auto-restart' },
    ],
    initialValue: existing?.installMode ?? 'simple',
  });
  if (isCancel(installMode)) {
    cancel('Cancelled.');
    return null;
  }

  const wantsDiscord = await confirm({
    message: 'Configure Discord agent-to-agent channel?',
    initialValue: existing?.discordA2aChannel !== null && existing?.discordA2aChannel !== undefined,
  });
  if (isCancel(wantsDiscord)) {
    cancel('Cancelled.');
    return null;
  }

  let discordA2aChannel: string | null = null;
  if (wantsDiscord) {
    const v = await text({
      message: 'Discord A2A channel ID',
      placeholder: '987654321098765432',
      initialValue: existing?.discordA2aChannel ?? undefined,
      validate: (value) => {
        if (value === undefined) return 'required';
        return /^\d{10,20}$/.test(value.trim()) ? undefined : 'expected a Discord snowflake id';
      },
    });
    if (isCancel(v)) {
      cancel('Cancelled.');
      return null;
    }
    discordA2aChannel = String(v).trim();
  }

  outro('Writing config…');

  return {
    telegramToken: String(telegramToken).trim(),
    telegramChatId: String(telegramChatId).trim(),
    defaultProvider: defaultProvider as ProviderChoice,
    defaultModel: String(defaultModel).trim() || DEFAULT_MODELS[defaultProvider as ProviderChoice],
    providerApiKey: String(providerApiKey ?? '').trim() || existing?.providerApiKey || '',
    discordA2aChannel,
    installMode: installMode as "simple" | "supervised",
  };
}

function validateNonInteractive(opts: OnboardOptions): WizardAnswers | string {
  if (!opts.acceptRisk) {
    return '--non-interactive requires --accept-risk (you are bypassing safety prompts)';
  }
  if (!opts.telegramToken) return '--telegram-token required in non-interactive mode';
  if (!opts.telegramChatId) return '--telegram-chat-id required in non-interactive mode';
  const provider = (opts.defaultProvider ?? 'openrouter') as ProviderChoice;
  if (!VALID_PROVIDERS.includes(provider)) {
    return `--default-provider must be one of: ${VALID_PROVIDERS.join(', ')}`;
  }
  return {
    telegramToken: opts.telegramToken,
    telegramChatId: opts.telegramChatId,
    defaultProvider: provider,
    defaultModel: opts.defaultModel ?? DEFAULT_MODELS[provider],
    providerApiKey: '',
    discordA2aChannel: opts.discordA2aChannel ?? null,
    installMode: 'supervised',
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
    const token = kv.get('TELEGRAM_BOT_TOKEN');
    const chatId = kv.get('MAIN_CHAT_ID');
    const provider = kv.get('DEFAULT_PROVIDER') as ProviderChoice | undefined;
    if (!token || !chatId || !provider) return null;
    return {
      telegramToken: token,
      telegramChatId: chatId,
      defaultProvider: VALID_PROVIDERS.includes(provider) ? provider : 'openrouter',
      defaultModel: kv.get('DEFAULT_MODEL') ?? DEFAULT_MODELS[provider] ?? DEFAULT_MODELS.openrouter,
      providerApiKey: kv.get(PROVIDER_API_KEY_ENV[provider] ?? 'OPENROUTER_API_KEY') ?? '',
      discordA2aChannel: kv.get('DISCORD_A2A_CHANNEL_ID') ?? null,
      installMode: 'simple',
    };
  } catch {
    return null;
  }
}

function mergeEnvContent(existing: string, answers: WizardAnswers): string {
  // Preserve lines the wizard doesn't own; overwrite the ones it does.
  const providerKeyName = PROVIDER_API_KEY_ENV[answers.defaultProvider];
  const owned = new Set([
    'TELEGRAM_BOT_TOKEN',
    'MAIN_CHAT_ID',
    'DEFAULT_PROVIDER',
    'DEFAULT_MODEL',
    'DISCORD_A2A_CHANNEL_ID',
    providerKeyName,
  ]);
  const keptLines: string[] = [];
  for (const line of existing.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (m && m[1] !== undefined && owned.has(m[1])) continue;
    keptLines.push(line);
  }
  // Trim trailing empty lines before appending.
  while (keptLines.length > 0 && keptLines[keptLines.length - 1] === '') keptLines.pop();

  const newBlock = [
    '',
    '# --- agentbridge onboard-managed ---',
    `TELEGRAM_BOT_TOKEN=${answers.telegramToken}`,
    `MAIN_CHAT_ID=${answers.telegramChatId}`,
    `DEFAULT_PROVIDER=${answers.defaultProvider}`,
    `DEFAULT_MODEL=${answers.defaultModel}`,
  ];
  if (answers.providerApiKey) {
    newBlock.push(`${providerKeyName}=${answers.providerApiKey}`);
  }
  if (answers.discordA2aChannel !== null) {
    newBlock.push(`DISCORD_A2A_CHANNEL_ID=${answers.discordA2aChannel}`);
  }

  return [...keptLines, ...newBlock, ''].join('\n');
}

export async function onboard(opts: OnboardOptions): Promise<number> {
  const paths = packagePaths('agentbridge');
  const manifest = await readManifest(paths.manifest);
  if (!manifest) {
    process.stderr.write(
      `Not installed yet. Run 'agentbridge install' first.\n(Manifest not found at ${paths.manifest}.)\n`,
    );
    return 2;
  }

  const envPath = join(paths.config, '.env');
  const existing = await readExisting(envPath);
  if (existing !== null && !opts.force) {
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

  // Write install mode (overrides any prior value — onboarding is authoritative)
  const { writeInstallMode } = await import('../install-mode.js');
  writeInstallMode(paths.home, answers.installMode);
  process.stdout.write(`✓ install mode: ${answers.installMode}\n`);

  process.stdout.write(`Next: 'agentbridge update' to build, then start the bridge${answers.installMode === 'simple' ? ' via ~/.agentbridge/agentbridge.sh' : ' via your watchdog'}.\n`);
  return 0;
}
