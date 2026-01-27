declare module 'eventsource' {
  export default class EventSource {
    onmessage: ((event: { data: string }) => void) | null;
    constructor(url: string, init?: { headers?: Record<string, string> });
    close(): void;
  }
}

declare module 'ws' {
  type ClientOptions = {
    handshakeTimeout?: number;
    agent?: unknown;
    headers?: Record<string, string>;
  };

  export default class WebSocket {
    static CONNECTING: number;
    static OPEN: number;
    static CLOSING: number;
    static CLOSED: number;
    constructor(url: string, options?: ClientOptions);
    constructor(url: string, protocols: string | string[], options?: ClientOptions);
    readyState: number;
    on(event: string, handler: (...args: unknown[]) => void): void;
    send(data: string): void;
    close(): void;
  }
}
