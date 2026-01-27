import { createOpenCodeClient } from './opencode-client.js';
import { InstanceManager } from './instance-manager.js';
import { DiscordClient } from './discord-client.js';
import { createBridge } from './bridge.js';
import type { AppConfig } from './config.js';

type CreateAppOptions = {
  config: AppConfig;
  exec: (command: string) => Promise<void>;
  fetch: typeof globalThis.fetch;
  DiscordClientImpl?: typeof DiscordClient;
  InstanceManagerImpl?: typeof InstanceManager;
};

export function createApp({
  config,
  exec,
  fetch,
  DiscordClientImpl = DiscordClient,
  InstanceManagerImpl = InstanceManager,
}: CreateAppOptions) {
  const openCodeClient = createOpenCodeClient({ fetch });
  let bridge: ReturnType<typeof createBridge> | null = null;

  const instanceManager = new InstanceManagerImpl({
    exec,
    portStart: config.portStart,
    hostname: config.opencodeHostname,
    opencodeBin: config.opencodeBin,
    tmuxBin: config.tmuxBin,
    onSseEvent: (instanceName, data) => {
      bridge?.handleSseEvent(instanceName, data);
    },
  });

  const discordClient = new DiscordClientImpl({
    token: config.discordBotToken,
    allowedGuildId: config.discordGuildId,
    allowedUserIds: config.discordAllowedUserIds,
    allowedChannelIds: config.discordAllowedChannelIds,
    requireMention: config.discordRequireMention,
    onReady: () => {
      console.log('[discord] ready');
    },
    onError: (err) => {
      if (err instanceof Error) {
        const cause = (err as { cause?: unknown }).cause;
        if (cause instanceof Error) {
          const code =
            typeof (cause as { code?: unknown }).code === 'string'
              ? ` code=${(cause as { code?: string }).code}`
              : '';
          console.error(
            `[discord] error ${err.name}: ${err.message} (cause: ${cause.name}: ${cause.message}${code})`,
          );
          return;
        }
        if (cause) {
          let causeText = '';
          try {
            causeText = JSON.stringify(cause);
          } catch {
            causeText = String(cause);
          }
          console.error(`[discord] error ${err.name}: ${err.message} (cause: ${causeText})`);
          return;
        }
        console.error(`[discord] error ${err.name}: ${err.message}`);
        return;
      }

      const msg = typeof err === 'string' ? err : JSON.stringify(err);
      console.error(`[discord] error ${msg}`);
    },
    onChat: (payload) => {
      console.log('[discord] event message');
      void bridge?.handleChat(payload);
    },
  });

  bridge = createBridge({
    gatewayClient: discordClient,
    instanceManager,
    openCodeClient,
    streamThrottleMs: config.streamThrottleMs,
  });

  return {
    start() {
      bridge?.start();
    },
    stop() {
      bridge?.stop();
    },
    gatewayClient: discordClient,
    instanceManager,
    bridge,
  };
}
