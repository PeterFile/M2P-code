function readNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function readCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export type AppConfig = {
  discordBotToken: string;
  discordGuildId?: string;
  discordAllowedUserIds: string[];
  discordAllowedChannelIds: string[];
  discordRequireMention: boolean;
  portStart: number;
  opencodeBin: string;
  tmuxBin: string;
  streamThrottleMs: number;
  opencodeHostname: string;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    discordBotToken: env.DISCORD_BOT_TOKEN ?? '',
    discordGuildId: env.DISCORD_GUILD_ID?.trim() || undefined,
    discordAllowedUserIds: readCsv(env.DISCORD_ALLOWED_USER_IDS),
    discordAllowedChannelIds: readCsv(env.DISCORD_ALLOWED_CHANNEL_IDS),
    discordRequireMention: readBool(env.DISCORD_REQUIRE_MENTION, false),
    portStart: readNumber(env.BRIDGE_PORT_START, 4096),
    opencodeBin: env.BRIDGE_OPENCODE_BIN ?? 'opencode',
    tmuxBin: env.BRIDGE_TMUX_BIN ?? 'tmux',
    streamThrottleMs: readNumber(env.BRIDGE_STREAM_THROTTLE_MS, 1000),
    opencodeHostname: env.BRIDGE_OPENCODE_HOSTNAME ?? '0.0.0.0',
  };
}
