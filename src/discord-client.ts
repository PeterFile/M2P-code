import WebSocket from 'ws';
import { ProxyAgent } from 'proxy-agent';

type DiscordClientOptions = {
  token: string;
  allowedGuildId?: string | null;
  allowedUserIds?: string[];
  allowedChannelIds?: string[];
  requireMention?: boolean;
  onChat?: (payload: { chatId?: string; threadId?: string; text: string }) => void;
  onError?: (error: unknown) => void;
  onReady?: () => void;
};

type Snowflake = string;

type DiscordGatewayFrame = {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
};

type DiscordUser = {
  id: Snowflake;
  bot?: boolean;
};

type DiscordMessageCreate = {
  id: Snowflake;
  channel_id: Snowflake;
  guild_id?: Snowflake;
  content?: string;
  author: DiscordUser;
};

type DiscordChannel = {
  id: Snowflake;
  type?: number;
  parent_id?: Snowflake | null;
};

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DISCORD_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

// https://discord.com/developers/docs/topics/gateway#gateway-intents
const INTENTS_GUILDS = 1 << 0;
const INTENTS_GUILD_MESSAGES = 1 << 9;
const INTENTS_MESSAGE_CONTENT = 1 << 15;

// Threads: GUILD_NEWS_THREAD(10), GUILD_PUBLIC_THREAD(11), GUILD_PRIVATE_THREAD(12)
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

function normalizeSnowflakeList(entries: string[] | undefined): Set<string> {
  return new Set((entries ?? []).map((e) => String(e).trim()).filter(Boolean));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitDiscordMessage(text: string, limit = 2000): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.length <= limit) {
    return [normalized];
  }

  const out: string[] = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    const lastNewline = slice.lastIndexOf('\n');
    const cut = lastNewline > limit * 0.5 ? lastNewline : limit;
    out.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  if (remaining.trim().length > 0) {
    out.push(remaining);
  }
  return out;
}

export class DiscordClient {
  private token: string;
  private allowedGuildId: string | null;
  private allowedUserIds: Set<string>;
  private allowedChannelIds: Set<string>;
  private requireMention: boolean;
  private onChat: (payload: { chatId?: string; threadId?: string; text: string }) => void;
  private onError: (error: unknown) => void;
  private onReady: () => void;

  private ws: WebSocket | null;
  private shouldReconnect: boolean;
  private reconnectTimer: NodeJS.Timeout | null;
  private backoffMs: number;
  private heartbeatTimer: NodeJS.Timeout | null;
  private seq: number | null;
  private botUserId: string | null;

  private channelCache: Map<string, { isThread: boolean; parentId?: string }>;

  constructor({
    token,
    allowedGuildId,
    allowedUserIds,
    allowedChannelIds,
    requireMention = false,
    onChat = () => {},
    onError = () => {},
    onReady = () => {},
  }: DiscordClientOptions) {
    this.token = token;
    this.allowedGuildId = allowedGuildId?.trim() || null;
    this.allowedUserIds = normalizeSnowflakeList(allowedUserIds);
    this.allowedChannelIds = normalizeSnowflakeList(allowedChannelIds);
    this.requireMention = requireMention;
    this.onChat = onChat;
    this.onError = onError;
    this.onReady = onReady;

    this.ws = null;
    this.shouldReconnect = false;
    this.reconnectTimer = null;
    this.backoffMs = 500;
    this.heartbeatTimer = null;
    this.seq = null;
    this.botUserId = null;
    this.channelCache = new Map();
  }

  connect(): void {
    this.shouldReconnect = true;
    if (this.ws) {
      return;
    }
    this.openSocket();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  sendMessage({
    chatId,
    threadId,
    text,
  }: {
    chatId: string;
    threadId?: string | null;
    text: string;
  }): void {
    const channelId = threadId ?? chatId;
    void this.sendToChannel(channelId, text).catch((err) => this.onError(err));
  }

  private openSocket(): void {
    const ws = new WebSocket(DISCORD_GATEWAY_URL, {
      handshakeTimeout: 30000,
      agent: new ProxyAgent(),
    });
    this.ws = ws;

    ws.on('open', () => {
      this.backoffMs = 500;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    });

    ws.on('message', (data) => {
      const raw = typeof data === 'string' ? data : String(data);
      try {
        const frame = JSON.parse(raw) as DiscordGatewayFrame;
        void this.handleGatewayFrame(frame);
      } catch (err) {
        this.onError(err);
      }
    });

    ws.on('error', (err) => this.onError(err));

    ws.on('close', () => {
      this.clearHeartbeat();
      this.ws = null;
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private clearHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private sendGateway(payload: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Discord gateway not connected');
    }
    ws.send(JSON.stringify(payload));
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      try {
        this.sendGateway({ op: 1, d: this.seq });
      } catch (err) {
        this.onError(err);
      }
    }, intervalMs);
  }

  private identify(): void {
    const intents = INTENTS_GUILDS | INTENTS_GUILD_MESSAGES | INTENTS_MESSAGE_CONTENT;
    this.sendGateway({
      op: 2,
      d: {
        token: this.token,
        intents,
        properties: {
          os: process.platform,
          browser: 'm2p-bridge',
          device: 'm2p-bridge',
        },
      },
    });
  }

  private async handleGatewayFrame(frame: DiscordGatewayFrame): Promise<void> {
    if (typeof frame.s === 'number') {
      this.seq = frame.s;
    }

    switch (frame.op) {
      case 10: {
        const hello = frame.d as { heartbeat_interval?: number } | undefined;
        const interval = hello?.heartbeat_interval;
        if (!interval) {
          throw new Error('Discord gateway HELLO missing heartbeat_interval');
        }
        this.startHeartbeat(interval);
        this.identify();
        return;
      }
      case 1:
        this.sendGateway({ op: 1, d: this.seq });
        return;
      case 7:
        this.ws?.close();
        return;
      case 9: {
        // INVALID_SESSION: wait a bit then re-identify.
        await sleep(1000 + Math.floor(Math.random() * 4000));
        this.identify();
        return;
      }
      case 0: {
        const eventType = frame.t;
        const payload = frame.d;
        if (eventType === 'READY') {
          const ready = payload as { user?: { id?: string } } | undefined;
          this.botUserId = ready?.user?.id ?? null;
          this.onReady();
          return;
        }
        if (eventType === 'MESSAGE_CREATE') {
          void this.handleMessageCreate(payload as DiscordMessageCreate).catch((err) =>
            this.onError(err),
          );
        }
        return;
      }
      default:
        return;
    }
  }

  private isAllowedGuild(message: DiscordMessageCreate): boolean {
    if (!this.allowedGuildId) {
      return true;
    }
    return message.guild_id === this.allowedGuildId;
  }

  private isAllowedAuthor(message: DiscordMessageCreate): boolean {
    if (this.allowedUserIds.size === 0) {
      return true;
    }
    return this.allowedUserIds.has(message.author.id);
  }

  private async resolveChannelMeta(
    channelId: string,
  ): Promise<{ isThread: boolean; parentId?: string }> {
    const cached = this.channelCache.get(channelId);
    if (cached) {
      return cached;
    }

    const res = await fetch(`${DISCORD_API_BASE}/channels/${channelId}`, {
      headers: {
        authorization: `Bot ${this.token}`,
      },
    });
    if (!res.ok) {
      throw new Error(`Discord API GET /channels/${channelId} failed: ${res.status}`);
    }
    const data = (await res.json()) as DiscordChannel;
    const type = typeof data.type === 'number' ? data.type : -1;
    const parentId = typeof data.parent_id === 'string' ? data.parent_id : undefined;
    const meta = { isThread: THREAD_CHANNEL_TYPES.has(type), parentId };
    this.channelCache.set(channelId, meta);
    return meta;
  }

  private async isAllowedChannel(message: DiscordMessageCreate): Promise<boolean> {
    if (this.allowedChannelIds.size === 0) {
      return true;
    }

    if (this.allowedChannelIds.has(message.channel_id)) {
      return true;
    }

    const meta = await this.resolveChannelMeta(message.channel_id);
    if (meta.isThread && meta.parentId && this.allowedChannelIds.has(meta.parentId)) {
      return true;
    }

    return false;
  }

  private shouldHandleMention(message: DiscordMessageCreate): boolean {
    if (!this.requireMention) {
      return true;
    }
    const botId = this.botUserId;
    if (!botId) {
      return false;
    }
    const content = message.content ?? '';
    return content.includes(`<@${botId}>`) || content.includes(`<@!${botId}>`);
  }

  private normalizeIncomingText(message: DiscordMessageCreate): string {
    const botId = this.botUserId;
    const content = (message.content ?? '').trim();
    if (!botId || !content) {
      return content;
    }
    return content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
  }

  private async handleMessageCreate(message: DiscordMessageCreate): Promise<void> {
    if (!message || !message.author) {
      return;
    }
    if (message.author.bot) {
      return;
    }
    if (!this.isAllowedGuild(message)) {
      return;
    }
    if (!this.isAllowedAuthor(message)) {
      return;
    }
    if (!(await this.isAllowedChannel(message))) {
      return;
    }
    if (!this.shouldHandleMention(message)) {
      return;
    }

    const text = this.normalizeIncomingText(message);
    if (!text) {
      return;
    }

    let threadId: string | undefined;
    let chatId: string | undefined;

    try {
      const meta = await this.resolveChannelMeta(message.channel_id);
      if (meta.isThread) {
        threadId = message.channel_id;
        chatId = meta.parentId ?? message.channel_id;
      } else {
        chatId = message.channel_id;
      }
    } catch {
      // If we can't resolve channel meta, still treat it as a standalone chat target.
      chatId = message.channel_id;
    }

    this.onChat({ chatId, threadId, text });
  }

  private async sendToChannel(channelId: string, text: string): Promise<void> {
    const chunks = splitDiscordMessage(text);
    for (const chunk of chunks) {
      const res = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bot ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: chunk }),
      });
      if (res.status === 429) {
        const data = (await res.json().catch(() => null)) as { retry_after?: number } | null;
        const retryAfterMs = Math.max(500, Math.floor((data?.retry_after ?? 1) * 1000));
        await sleep(retryAfterMs);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Discord API POST /channels/${channelId}/messages failed: ${res.status} ${body}`);
      }
    }
  }
}
