import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordClient } from '../src/discord-client.js';

test('sendMessage retries on 429 instead of dropping the chunk', async () => {
  const calls: { url: string; method: string; body: string }[] = [];
  let attempt = 0;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, method, body });

    attempt++;
    if (attempt === 1) {
      return new Response(JSON.stringify({ retry_after: 0 }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('', { status: 200 });
  };

  const client = new DiscordClient({
    token: 'test',
    fetchImpl,
  });

  client.sendMessage({ chatId: 'chan-1', text: 'hello' });
  await (client as unknown as { sendQueue: Map<string, Promise<void>> }).sendQueue.get('chan-1');

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/channels\/chan-1\/messages$/);
  assert.match(calls[0].body, /"content":"hello"/);
});
