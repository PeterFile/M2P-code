import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenCodeClient } from '../src/opencode-client.js';

function createFetchStub() {
  const calls: { url: string; options: RequestInit }[] = [];
  const fetchStub = async (url: string, options: RequestInit) => {
    calls.push({ url, options });
    return {
      ok: true,
      async json() {
        return { id: 'sess-1' };
      },
    } as Response;
  };
  return { calls, fetchStub };
}

test('createSession posts to /session and returns id', async () => {
  const { calls, fetchStub } = createFetchStub();
  const client = createOpenCodeClient({ fetch: fetchStub });

  const session = await client.createSession(4096);

  assert.equal(session.id, 'sess-1');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /4096\/session$/);
  assert.equal(calls[0].options.method, 'POST');
});

test('sendMessage posts message parts', async () => {
  const { calls, fetchStub } = createFetchStub();
  const client = createOpenCodeClient({ fetch: fetchStub });

  await client.sendMessage(4096, 'sess-1', 'hello');

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /4096\/session\/sess-1\/message$/);
  const body = JSON.parse(calls[0].options.body as string);
  assert.equal(body.parts[0].text, 'hello');
});
