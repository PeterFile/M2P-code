import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

type WebSocketLike = {
  readyState: number;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  send: (data: string) => void;
  close: () => void;
};

type WebSocketCtor = {
  new (url: string): WebSocketLike;
  OPEN?: number;
};

type Clock = {
  setTimeout: (handler: () => void, timeout: number) => number | NodeJS.Timeout;
  clearTimeout: (handle: number | NodeJS.Timeout | undefined) => void;
};

type GatewayClientOptions = {
  url: string;
  token: string;
  clientId?: string;
  clientMode?: string;
  WebSocketImpl?: WebSocketCtor;
  onChat?: (payload: { chatId?: string; threadId?: string; text: string }) => void;
  onError?: (error: unknown) => void;
  onOpen?: () => void;
  onClose?: (code?: unknown, reason?: unknown) => void;
  onReady?: (hello: unknown) => void;
  createRequestId?: () => string;
  createIdempotencyKey?: () => string;
  clock?: Clock;
  maxBackoffMs?: number;
};

export class GatewayClient {
  private url: string;
  private token: string;
  private WebSocketImpl: WebSocketCtor;
  private onChat: (payload: { chatId?: string; threadId?: string; text: string }) => void;
  private onError: (error: unknown) => void;
  private onOpen: () => void;
  private onClose: (code?: unknown, reason?: unknown) => void;
  private onReady: (hello: unknown) => void;
  private createRequestId: () => string;
  private createIdempotencyKey: () => string;
  private clientId: string;
  private clientMode: string;
  private clock: Clock;
  private maxBackoffMs: number;
  private backoffMs: number;
  private shouldReconnect: boolean;
  private reconnectTimer: number | NodeJS.Timeout | null;
  private ws: WebSocketLike | null;
  private connectReqId: string | null;
  private inflight: Map<string, string>;

  constructor({
    url,
    token,
    clientId = 'cli',
    clientMode = 'cli',
    WebSocketImpl = WebSocket as unknown as WebSocketCtor,
    onChat = () => {},
    onError = () => {},
    onOpen = () => {},
    onClose = () => {},
    onReady = () => {},
    createRequestId = () => randomUUID(),
    createIdempotencyKey = () => randomUUID(),
    clock = { setTimeout, clearTimeout },
    maxBackoffMs = 30000,
  }: GatewayClientOptions) {
    this.url = url;
    this.token = token;
    this.WebSocketImpl = WebSocketImpl;
    this.onChat = onChat;
    this.onError = onError;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.onReady = onReady;
    this.createRequestId = createRequestId;
    this.createIdempotencyKey = createIdempotencyKey;
    this.clientId = clientId;
    this.clientMode = clientMode;
    this.clock = clock;
    this.maxBackoffMs = maxBackoffMs;
    this.backoffMs = 500;
    this.shouldReconnect = false;
    this.reconnectTimer = null;
    this.ws = null;
    this.connectReqId = null;
    this.inflight = new Map();
  }

  connect(): void {
    this.shouldReconnect = true;
    this.openSocket();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer !== null) {
      this.clock.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
    }
  }

  private openSocket(): void {
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;

    ws.on('open', () => {
      this.backoffMs = 500;
      if (this.reconnectTimer) {
        this.clock.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.onOpen();
      this.sendConnect();
    });

    ws.on('message', (data) => {
      const raw = typeof data === 'string' ? data : String(data);
      try {
        const message = JSON.parse(raw) as {
          type?: string;
          id?: string;
          method?: string;
          params?: unknown;
          ok?: boolean;
          payload?: unknown;
          error?: unknown;
          event?: string;
        };

        if (message.type === 'event' && message.event === 'chat') {
          this.onChat(message.payload as { chatId?: string; threadId?: string; text: string });
          return;
        }

        if (message.type === 'res' && message.id && this.connectReqId) {
          const method = this.inflight.get(message.id);
          if (method) {
            this.inflight.delete(message.id);
          }
          if (message.id === this.connectReqId) {
            if (message.ok) {
              this.onReady(message.payload);
              return;
            }
            this.onError(message.error ?? message.payload);
            return;
          }
          if (method && !message.ok) {
            this.onError({ method, error: message.error ?? message.payload });
          }
        }
      } catch (err) {
        this.onError(err);
      }
    });

    ws.on('close', (code, reason) => {
      this.onClose(code, reason);
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      this.onError(err);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private sendRaw(message: unknown): void {
    const openState = this.WebSocketImpl.OPEN ?? 1;
    if (!this.ws || this.ws.readyState !== openState) {
      throw new Error('WebSocket is not open');
    }
    this.ws.send(JSON.stringify(message));
  }

  sendMessage({
    chatId,
    threadId,
    text,
  }: {
    chatId: string;
    threadId?: string | null;
    text: string;
  }): string {
    const idempotencyKey = this.createIdempotencyKey();
    this.sendReq('chat.send', {
      chatId,
      threadId: threadId ?? undefined,
      text,
      idempotencyKey,
    });
    return idempotencyKey;
  }

  private sendReq(method: string, params: unknown): string {
    const id = this.createRequestId();
    this.inflight.set(id, method);
    this.sendRaw({ type: 'req', id, method, params });
    return id;
  }

  private sendConnect(): void {
    // Protocol v3 handshake (minimal fields).
    this.connectReqId = this.sendReq('connect', {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: this.clientId,
        version: '0.1.0',
        platform: process.platform,
        mode: this.clientMode,
      },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      caps: [],
      commands: [],
      permissions: {},
      auth: { token: this.token },
      locale: 'zh-CN',
      userAgent: 'clawdbot-cli/0.1.0',
    });
  }
}
