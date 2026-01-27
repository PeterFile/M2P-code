import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../src/bridge.js';

function createGatewayStub() {
  const sent: { chatId: string; threadId: string; text: string }[] = [];
  return {
    sent,
    connect() {},
    disconnect() {},
    sendMessage(payload: { chatId: string; threadId: string; text: string }) {
      sent.push(payload);
    },
  };
}

test('bridge replies to slash commands', async () => {
  const gatewayClient = createGatewayStub();
  const instanceManager = {
    list() {
      return [];
    },
    async spawn() {
      return {
        name: 'stub',
        port: 4096,
        directory: '/tmp',
        tmuxSession: 'opencode-stub',
      };
    },
    async kill() {},
    bind() {},
    unbind() {},
    getBinding() {
      return null;
    },
    getInstance() {
      return null;
    },
    findThreadByInstanceSession() {
      return null;
    },
  };
  const openCodeClient = {
    async sendMessage() {},
    async respondPermission() {},
  };

  const bridge = createBridge({
    gatewayClient,
    instanceManager,
    openCodeClient,
    streamThrottleMs: 0,
  });

  await bridge.handleChat({
    chatId: 'chat-1',
    threadId: 'thread-1',
    text: '/instances',
  });

  assert.equal(gatewayClient.sent.length, 1);
  assert.match(gatewayClient.sent[0].text, /实例/);
});

test('bridge forwards normal messages to opencode', async () => {
  const gatewayClient = createGatewayStub();
  const openCodeCalls: { port: number; sessionId: string; text: string }[] = [];
  const instanceManager = {
    list() {
      return [];
    },
    async spawn() {
      return {
        name: 'stub',
        port: 4096,
        directory: '/tmp',
        tmuxSession: 'opencode-stub',
      };
    },
    async kill() {},
    bind() {},
    unbind() {},
    getBinding() {
      return {
        instance: {
          name: 'backend',
          port: 4096,
          directory: '/srv/api',
          tmuxSession: 'opencode-backend',
        },
        sessionId: 'sess-1',
      };
    },
    getInstance() {
      return {
        name: 'backend',
        port: 4096,
        directory: '/srv/api',
        tmuxSession: 'opencode-backend',
      };
    },
    findThreadByInstanceSession() {
      return null;
    },
  };
  const openCodeClient = {
    async sendMessage(port: number, sessionId: string, text: string) {
      openCodeCalls.push({ port, sessionId, text });
    },
    async respondPermission() {},
  };

  const bridge = createBridge({
    gatewayClient,
    instanceManager,
    openCodeClient,
    streamThrottleMs: 0,
  });

  await bridge.handleChat({
    chatId: 'chat-1',
    threadId: 'thread-1',
    text: 'hi',
  });

  assert.equal(openCodeCalls.length, 1);
  assert.equal(openCodeCalls[0].sessionId, 'sess-1');
});
