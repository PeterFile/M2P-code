import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { installProxySupportFromEnv } from './proxy.js';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const exec = promisify(execCallback);

installProxySupportFromEnv();

const config = loadConfig();

if (!config.discordBotToken) {
  console.error('DISCORD_BOT_TOKEN is required');
  process.exit(1);
}

console.log(`[bridge] start portStart=${config.portStart}`);
if (config.discordGuildId) {
  console.log(`[bridge] discord guild=${config.discordGuildId}`);
}

const app = createApp({
  config,
  exec: (command) => exec(command).then(() => undefined),
  fetch: globalThis.fetch,
});

app.start();

const shutdown = () => {
  app.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
