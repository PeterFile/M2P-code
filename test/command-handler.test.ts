import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSlashCommand } from '../src/command-handler.js';

function createManagerStub() {
  const calls = {
    spawn: [] as { name: string; directory: string }[],
    kill: [] as string[],
    bind: [] as { threadId: string; instanceName: string; sessionId: string }[],
    unbind: [] as string[],
  };
  const instances = new Map([
    [
      'backend',
      {
        name: 'backend',
        port: 4096,
        directory: '/srv/api',
        tmuxSession: 'opencode-backend',
      },
    ],
  ]);
  return {
    calls,
    list() {
      return Array.from(instances.values());
    },
    getInstance(name: string) {
      return instances.get(name) ?? null;
    },
    async spawn(name: string, directory: string) {
      calls.spawn.push({ name, directory });
      const instance = {
        name,
        port: 4097,
        directory,
        tmuxSession: `opencode-${name}`,
      };
      instances.set(name, instance);
      return instance;
    },
    async kill(name: string) {
      calls.kill.push(name);
      instances.delete(name);
    },
    bind(threadId: string, instanceName: string, sessionId: string) {
      calls.bind.push({ threadId, instanceName, sessionId });
    },
    unbind(threadId: string) {
      calls.unbind.push(threadId);
    },
    getBinding() {
      return null;
    },
  };
}

test('handles /instances', async () => {
  const instanceManager = createManagerStub();
  const openCodeClient = {};

  const result = await handleSlashCommand('/instances', {
    chatId: 'chat-1',
    threadId: 'thread-1',
    instanceManager,
    openCodeClient,
  });

  assert.equal(result.handled, true);
  assert.match(result.replyText, /backend/);
});

test('handles /spawn', async () => {
  const instanceManager = createManagerStub();
  const openCodeClient = {};

  const result = await handleSlashCommand('/spawn docs /srv/docs', {
    chatId: 'chat-1',
    threadId: 'thread-1',
    instanceManager,
    openCodeClient,
  });

  assert.equal(result.handled, true);
  assert.equal(instanceManager.calls.spawn.length, 1);
  assert.match(result.replyText, /docs/);
});

test('handles /connect and creates a session', async () => {
  const instanceManager = createManagerStub();
  const openCodeClient = {
    async createSession(port: number) {
      return { id: `sess-${port}` };
    },
  };

  const result = await handleSlashCommand('/connect backend', {
    chatId: 'chat-1',
    threadId: 'thread-1',
    instanceManager,
    openCodeClient,
  });

  assert.equal(result.handled, true);
  assert.equal(instanceManager.calls.bind.length, 1);
  assert.match(result.replyText, /backend/);
});

test('handles /status with no binding', async () => {
  const instanceManager = createManagerStub();
  const openCodeClient = {};

  const result = await handleSlashCommand('/status', {
    chatId: 'chat-1',
    threadId: 'thread-1',
    instanceManager,
    openCodeClient,
  });

  assert.equal(result.handled, true);
  assert.match(result.replyText, /未绑定/);
});
