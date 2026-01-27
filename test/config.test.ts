import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loadConfig uses defaults', () => {
  const config = loadConfig({});
  assert.equal(config.discordBotToken, '');
  assert.equal(config.discordGuildId, undefined);
  assert.deepEqual(config.discordAllowedUserIds, []);
  assert.deepEqual(config.discordAllowedChannelIds, []);
  assert.equal(config.discordRequireMention, false);
  assert.equal(config.portStart, 4096);
  assert.equal(config.opencodeBin, 'opencode');
  assert.equal(config.tmuxBin, 'tmux');
  assert.equal(config.streamThrottleMs, 1000);
  assert.equal(config.opencodeHostname, '0.0.0.0');
});

test('loadConfig reads environment overrides', () => {
  const config = loadConfig({
    DISCORD_BOT_TOKEN: 'bot-token',
    DISCORD_GUILD_ID: 'guild-1',
    DISCORD_ALLOWED_USER_IDS: 'u1, u2',
    DISCORD_ALLOWED_CHANNEL_IDS: 'c1,c2',
    DISCORD_REQUIRE_MENTION: 'true',
    BRIDGE_PORT_START: '5000',
    BRIDGE_OPENCODE_BIN: '/usr/bin/opencode',
    BRIDGE_TMUX_BIN: '/usr/bin/tmux',
    BRIDGE_STREAM_THROTTLE_MS: '2500',
    BRIDGE_OPENCODE_HOSTNAME: '127.0.0.1',
  });
  assert.equal(config.discordBotToken, 'bot-token');
  assert.equal(config.discordGuildId, 'guild-1');
  assert.deepEqual(config.discordAllowedUserIds, ['u1', 'u2']);
  assert.deepEqual(config.discordAllowedChannelIds, ['c1', 'c2']);
  assert.equal(config.discordRequireMention, true);
  assert.equal(config.portStart, 5000);
  assert.equal(config.opencodeBin, '/usr/bin/opencode');
  assert.equal(config.tmuxBin, '/usr/bin/tmux');
  assert.equal(config.streamThrottleMs, 2500);
  assert.equal(config.opencodeHostname, '127.0.0.1');
});
