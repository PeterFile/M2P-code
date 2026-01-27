import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayClient } from '../src/gateway-client.js';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  static OPEN_STATE = 1;

  url: string;
  readyState: number;
  sent: string[];
  handlers: Map<string, (...args: unknown[]) => void>;

  constructor(url: string) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.handlers = new Map();
    FakeWebSocket.instances.push(this);
  }

  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, handler);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {}

  emit(event: string, ...args: unknown[]) {
    const handler = this.handlers.get(event);
    if (handler) {
      handler(...args);
    }
  }
}

test('connect sends connect req frame with token', () => {
  FakeWebSocket.instances = [];
  const client = new GatewayClient({
    url: 'ws://localhost:18789',
    token: 'token-1',
    WebSocketImpl: FakeWebSocket,
    createRequestId: () => 'req-1',
  });

  client.connect();
  const ws = FakeWebSocket.instances[0];
  ws.readyState = FakeWebSocket.OPEN;
  ws.emit('open');

  const message = JSON.parse(ws.sent[0]);
  assert.equal(message.type, 'req');
  assert.equal(message.id, 'req-1');
  assert.equal(message.method, 'connect');
  assert.equal(message.params.auth.token, 'token-1');
  assert.equal(message.params.client.id, 'cli');
  assert.equal(message.params.client.mode, 'cli');
});

test('sendMessage sends chat.send req with idempotencyKey', () => {
  FakeWebSocket.instances = [];
  const client = new GatewayClient({
    url: 'ws://localhost:18789',
    token: 'token-1',
    WebSocketImpl: FakeWebSocket,
    createRequestId: () => 'req-1',
    createIdempotencyKey: () => 'idem-1',
  });

  client.connect();
  const ws = FakeWebSocket.instances[0];
  ws.readyState = FakeWebSocket.OPEN;
  ws.emit('open');

  client.sendMessage({ chatId: 'chat-1', threadId: 'thread-1', text: 'hi' });

  const message = JSON.parse(ws.sent[1]);
  assert.equal(message.type, 'req');
  assert.equal(message.method, 'chat.send');
  assert.equal(message.params.chatId, 'chat-1');
  assert.equal(message.params.threadId, 'thread-1');
  assert.equal(message.params.text, 'hi');
  assert.equal(message.params.idempotencyKey, 'idem-1');
});

test('event chat dispatches to onChat', () => {
  FakeWebSocket.instances = [];
  const chats: unknown[] = [];
  const client = new GatewayClient({
    url: 'ws://localhost:18789',
    token: 'token-1',
    WebSocketImpl: FakeWebSocket,
    createRequestId: () => 'req-1',
    onChat: (payload) => chats.push(payload),
  });

  client.connect();
  const ws = FakeWebSocket.instances[0];
  ws.emit('message',
    JSON.stringify({
      type: 'event',
      event: 'chat',
      payload: { chatId: 'chat-1', threadId: 'thread-1', text: 'hello' },
    }),
  );

  assert.equal(chats.length, 1);
});

test('close schedules reconnect with backoff', () => {
  FakeWebSocket.instances = [];
  const timeouts: { fn: () => void; ms: number }[] = [];
  const clock = {
    setTimeout(fn: () => void, ms: number) {
      timeouts.push({ fn, ms });
      return timeouts.length;
    },
    clearTimeout() {},
  };

  const client = new GatewayClient({
    url: 'ws://localhost:18789',
    token: 'token-1',
    WebSocketImpl: FakeWebSocket,
    createRequestId: () => 'req-1',
    clock,
  });

  client.connect();
  const ws = FakeWebSocket.instances[0];
  ws.emit('close');

  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].ms, 500);
});
