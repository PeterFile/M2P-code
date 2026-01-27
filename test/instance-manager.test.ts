import test from 'node:test';
import assert from 'node:assert/strict';
import { InstanceManager } from '../src/instance-manager.js';

function createFakes() {
  const commands: string[] = [];
  const exec = async (cmd: string) => {
    commands.push(cmd);
  };
  const eventSources: { url: string; closed: boolean; close: () => void }[] = [];
  const createEventSource = (url: string) => {
    const es = {
      url,
      closed: false,
      close() {
        this.closed = true;
      },
    };
    eventSources.push(es);
    return es;
  };
  const waitForHealth = async () => {};
  return { commands, exec, eventSources, createEventSource, waitForHealth };
}

test('spawn creates instance and increments port', async () => {
  const { commands, exec, eventSources, createEventSource, waitForHealth } =
    createFakes();
  const manager = new InstanceManager({
    exec,
    waitForHealth,
    createEventSource,
    portStart: 4096,
    hostname: '0.0.0.0',
    opencodeBin: 'opencode',
    tmuxBin: 'tmux',
  });

  const instance = await manager.spawn('backend', '/srv/api');

  assert.equal(instance.port, 4096);
  assert.equal(instance.name, 'backend');
  assert.equal(manager.list().length, 1);
  assert.equal(eventSources.length, 1);
  assert.ok(commands[0].includes('tmux'));
  assert.ok(commands[0].includes('opencode serve --port 4096'));
});

test('spawn rejects duplicate instance names', async () => {
  const { exec, createEventSource, waitForHealth } = createFakes();
  const manager = new InstanceManager({
    exec,
    waitForHealth,
    createEventSource,
    portStart: 4096,
    hostname: '0.0.0.0',
    opencodeBin: 'opencode',
    tmuxBin: 'tmux',
  });

  await manager.spawn('backend', '/srv/api');

  await assert.rejects(
    () => manager.spawn('backend', '/srv/api'),
    /already exists/i,
  );
});

test('kill removes instance, closes SSE, and clears bindings', async () => {
  const { commands, exec, eventSources, createEventSource, waitForHealth } =
    createFakes();
  const manager = new InstanceManager({
    exec,
    waitForHealth,
    createEventSource,
    portStart: 4096,
    hostname: '0.0.0.0',
    opencodeBin: 'opencode',
    tmuxBin: 'tmux',
  });

  await manager.spawn('backend', '/srv/api');
  manager.bind('thread-1', 'backend', 'sess-1');

  await manager.kill('backend');

  assert.equal(manager.list().length, 0);
  assert.equal(manager.getBinding('thread-1'), null);
  assert.equal(eventSources[0].closed, true);
  assert.ok(commands.some((cmd) => cmd.includes('kill-session')));
});

test('bind and getBinding returns instance and session', async () => {
  const { exec, createEventSource, waitForHealth } = createFakes();
  const manager = new InstanceManager({
    exec,
    waitForHealth,
    createEventSource,
    portStart: 4096,
    hostname: '0.0.0.0',
    opencodeBin: 'opencode',
    tmuxBin: 'tmux',
  });

  await manager.spawn('backend', '/srv/api');
  manager.bind('thread-1', 'backend', 'sess-1');

  const binding = manager.getBinding('thread-1');
  assert.ok(binding);
  assert.equal(binding.sessionId, 'sess-1');
  assert.equal(binding.instance.name, 'backend');
});
