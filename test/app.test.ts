import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

class DiscordStub {
  options: { token: string };
  connectCalls = 0;
  disconnectCalls = 0;

  constructor(options: { token: string }) {
    this.options = options;
  }

  connect() {
    this.connectCalls += 1;
  }

  disconnect() {
    this.disconnectCalls += 1;
  }

  sendMessage() {}
}

class InstanceManagerStub {
  options: {
    portStart: number;
    hostname: string;
    opencodeBin: string;
    tmuxBin: string;
  };

  constructor(options: {
    portStart: number;
    hostname: string;
    opencodeBin: string;
    tmuxBin: string;
  }) {
    this.options = options;
  }
}

test('createApp wires config into constructors', () => {
  const config: AppConfig = {
    discordBotToken: 'bot-token',
    discordGuildId: 'guild-1',
    discordAllowedUserIds: [],
    discordAllowedChannelIds: [],
    discordRequireMention: false,
    portStart: 5000,
    opencodeHostname: '127.0.0.1',
    opencodeBin: '/bin/opencode',
    tmuxBin: '/bin/tmux',
    streamThrottleMs: 2000,
  };

  const app = createApp({
    config,
    exec: async () => {},
    fetch: async () => ({ ok: true, json: async () => ({}) }) as Response,
    DiscordClientImpl: DiscordStub as never,
    InstanceManagerImpl: InstanceManagerStub as never,
  });

  assert.equal(app.gatewayClient.options.token, config.discordBotToken);
  assert.equal(app.instanceManager.options.portStart, config.portStart);
  assert.equal(app.instanceManager.options.hostname, config.opencodeHostname);
  assert.equal(app.instanceManager.options.opencodeBin, config.opencodeBin);
  assert.equal(app.instanceManager.options.tmuxBin, config.tmuxBin);
});

test('start triggers gateway connect', () => {
  const config: AppConfig = {
    discordBotToken: 'bot-token',
    discordAllowedUserIds: [],
    discordAllowedChannelIds: [],
    discordRequireMention: false,
    portStart: 4096,
    opencodeHostname: '0.0.0.0',
    opencodeBin: 'opencode',
    tmuxBin: 'tmux',
    streamThrottleMs: 1000,
  };

  const app = createApp({
    config,
    exec: async () => {},
    fetch: async () => ({ ok: true, json: async () => ({}) }) as Response,
    DiscordClientImpl: DiscordStub as never,
    InstanceManagerImpl: InstanceManagerStub as never,
  });

  app.start();
  assert.equal(app.gatewayClient.connectCalls, 1);
});
