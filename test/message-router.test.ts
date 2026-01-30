import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageRouter } from '../src/message-router.js';
import { InstanceManager } from '../src/instance-manager.js';

function createManager() {
  const exec = async () => {};
  const waitForHealth = async () => {};
  const createEventSource = () => ({ close() {} });
  return new InstanceManager({
    exec,
    waitForHealth,
    createEventSource,
    portStart: 4096,
    hostname: '0.0.0.0',
    opencodeBin: 'opencode',
    tmuxBin: 'tmux',
  });
}

test('unbound thread receives warning', async () => {
  const instanceManager = createManager();
  const replies: { targetId: string; text: string }[] = [];
  const router = createMessageRouter({
    instanceManager,
    openCodeClient: {
      async sendMessage() {},
      async respondPermission() {},
    },
    sendReply: (targetId, text) => {
      replies.push({ targetId, text });
    },
  });

  await router.handleChatMessage({
    chatId: 'chat-1',
    threadId: 'thread-1',
    text: 'hello',
  });

  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /未绑定/);
});

test('bound thread sends message to opencode', async () => {
  const instanceManager = createManager();
  await instanceManager.spawn('backend', '/srv/api');
  instanceManager.bind('thread-1', 'backend', 'sess-1');

  const sent: { port: number; sessionId: string; text: string }[] = [];
  const router = createMessageRouter({
    instanceManager,
    openCodeClient: {
      async sendMessage(port, sessionId, text) {
        sent.push({ port, sessionId, text });
      },
      async respondPermission() {},
    },
    sendReply: () => {},
  });

  await router.handleChatMessage({
    chatId: 'chat-1',
    threadId: 'thread-1',
    text: 'hi',
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].port, 4096);
  assert.equal(sent[0].sessionId, 'sess-1');
});

test('permission confirmation forwards to opencode', async () => {
  const instanceManager = createManager();
  await instanceManager.spawn('backend', '/srv/api');
  instanceManager.bind('thread-1', 'backend', 'sess-1');

  const replies: { targetId: string; text: string }[] = [];
  const confirmations: {
    port: number;
    sessionId: string;
    permissionId: string;
    allow: boolean;
  }[] = [];
  const router = createMessageRouter({
    instanceManager,
    openCodeClient: {
      async sendMessage() {},
      async respondPermission(port, sessionId, permissionId, allow) {
        confirmations.push({ port, sessionId, permissionId, allow });
      },
    },
    sendReply: (targetId, text) => {
      replies.push({ targetId, text });
    },
  });

  await router.handlePermissionRequest('backend', {
    sessionId: 'sess-1',
    permissionID: 'perm-1',
    tool: 'bash',
    details: { command: 'ls' },
  });

  await router.handleUserConfirmation('thread-1', 'Y');

  assert.equal(replies.length, 1);
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].allow, true);
});

test('streams assistant text via sendStreamReply with session key', async () => {
  const instanceManager = createManager();
  await instanceManager.spawn('backend', '/srv/api');
  instanceManager.bind('thread-1', 'backend', 'sess-1');

  const replies: { targetId: string; text: string; sessionKey?: string }[] = [];
  const router = createMessageRouter({
    instanceManager,
    openCodeClient: {
      async sendMessage() {},
      async respondPermission() {},
    },
    sendReply: (targetId, text) => {
      replies.push({ targetId, text });
    },
    sendStreamReply: (targetId, sessionKey, text) => {
      replies.push({ targetId, text, sessionKey });
    },
    streamThrottleMs: 0,
  });

  await router.handleSseEvent('backend', {
    type: 'message.updated',
    properties: { info: { id: 'msg-1', role: 'assistant', sessionID: 'sess-1' } },
  });

  await router.handleSseEvent('backend', {
    type: 'message.part.updated',
    properties: {
      part: {
        sessionID: 'sess-1',
        messageID: 'msg-1',
        type: 'text',
        text: 'pong',
      },
    },
  });

  // Streaming sends immediately with throttle=0
  assert.equal(replies.length, 1);
  assert.equal(replies[0].targetId, 'thread-1');
  assert.equal(replies[0].text, 'pong');
  assert.equal(replies[0].sessionKey, 'sess-1');

  // Session complete should not duplicate if no new content
  await router.handleSseEvent('backend', {
    type: 'session.completed',
    properties: { sessionId: 'sess-1' },
  });

  assert.equal(replies.length, 1);
});

test('streaming updates send cumulative text via sendStreamReply', async () => {
  const instanceManager = createManager();
  await instanceManager.spawn('backend', '/srv/api');
  instanceManager.bind('thread-1', 'backend', 'sess-1');

  const replies: { targetId: string; text: string; sessionKey?: string }[] = [];
  const router = createMessageRouter({
    instanceManager,
    openCodeClient: {
      async sendMessage() {},
      async respondPermission() {},
    },
    sendReply: (targetId, text) => {
      replies.push({ targetId, text });
    },
    sendStreamReply: (targetId, sessionKey, text) => {
      replies.push({ targetId, text, sessionKey });
    },
    streamThrottleMs: 0,
  });

  await router.handleSseEvent('backend', {
    type: 'message.updated',
    properties: { info: { id: 'msg-1', role: 'assistant', sessionID: 'sess-1' } },
  });

  await router.handleSseEvent('backend', {
    type: 'message.part.updated',
    properties: {
      part: {
        sessionID: 'sess-1',
        messageID: 'msg-1',
        type: 'text',
        text: 'hello',
      },
    },
  });

  await router.handleSseEvent('backend', {
    type: 'message.part.updated',
    properties: {
      part: {
        sessionID: 'sess-1',
        messageID: 'msg-1',
        type: 'text',
        text: 'hello world',
      },
    },
  });

  // Each update triggers a send with cumulative text
  assert.equal(replies.length, 2);
  assert.equal(replies[0].text, 'hello');
  assert.equal(replies[1].text, 'hello world');

  await router.handleSseEvent('backend', {
    type: 'session.completed',
    properties: { sessionId: 'sess-1' },
  });

  // No duplicate on completion since text already sent
  assert.equal(replies.length, 2);
});
