import EventSource from 'eventsource';

type ExecFn = (command: string) => Promise<void>;
type WaitForHealthFn = (baseUrl: string) => Promise<void>;
export type SseClient = {
  onmessage?: ((event: { data: string }) => void) | null;
  close?: () => void;
};

type CreateEventSourceFn = (url: string) => SseClient;

export type SseEvent = { type?: string; properties?: unknown };
type SseHandler = (instanceName: string, data: SseEvent) => void;

export type Instance = {
  name: string;
  port: number;
  directory: string;
  tmuxSession: string;
  sseClient: SseClient | null;
};

type ThreadBinding = { instanceName: string; sessionId: string };

type InstanceManagerOptions = {
  exec: ExecFn;
  waitForHealth?: WaitForHealthFn;
  createEventSource?: CreateEventSourceFn;
  portStart?: number;
  hostname?: string;
  opencodeBin?: string;
  tmuxBin?: string;
  onSseEvent?: SseHandler | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultWaitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 10000;
  const url = `${baseUrl}/session`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) {
        return;
      }
    } catch {
      // ignore and retry
    }
    await sleep(250);
  }
  throw new Error(`OpenCode health check timed out for ${baseUrl}`);
}

export class InstanceManager {
  private exec: ExecFn;
  private waitForHealth: WaitForHealthFn;
  private createEventSource: CreateEventSourceFn;
  private hostname: string;
  private opencodeBin: string;
  private tmuxBin: string;
  private onSseEvent: SseHandler | null;
  private instances: Map<string, Instance>;
  private threadBindings: Map<string, ThreadBinding>;
  private nextPort: number;

  constructor({
    exec,
    waitForHealth = defaultWaitForHealth,
    createEventSource = (url) => new EventSource(url),
    portStart = 4096,
    hostname = '0.0.0.0',
    opencodeBin = 'opencode',
    tmuxBin = 'tmux',
    onSseEvent = null,
  }: InstanceManagerOptions) {
    this.exec = exec;
    this.waitForHealth = waitForHealth;
    this.createEventSource = createEventSource;
    this.hostname = hostname;
    this.opencodeBin = opencodeBin;
    this.tmuxBin = tmuxBin;
    this.onSseEvent = onSseEvent;
    this.instances = new Map();
    this.threadBindings = new Map();
    this.nextPort = portStart;
  }

  async spawn(name: string, directory: string): Promise<Instance> {
    if (this.instances.has(name)) {
      throw new Error(`Instance '${name}' already exists`);
    }
    const port = this.nextPort++;
    const tmuxSession = `opencode-${name}`;
    const command =
      `${this.tmuxBin} new-session -d -s ${tmuxSession} -c ${directory} ` +
      `'${this.opencodeBin} serve --port ${port} --hostname ${this.hostname}'`;

    await this.exec(command);
    await this.waitForHealth(`http://localhost:${port}`);

    const sseClient = this.createEventSource(
      `http://localhost:${port}/event`,
    );
    if (this.onSseEvent) {
      sseClient.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as SseEvent;
          this.onSseEvent?.(name, data);
        } catch {
          // ignore malformed events
        }
      };
    }

    const instance: Instance = {
      name,
      port,
      directory,
      tmuxSession,
      sseClient,
    };

    this.instances.set(name, instance);
    return instance;
  }

  async kill(name: string): Promise<void> {
    const instance = this.instances.get(name);
    if (!instance) {
      throw new Error(`Instance '${name}' not found`);
    }
    instance.sseClient?.close?.();
    await this.exec(`${this.tmuxBin} kill-session -t ${instance.tmuxSession}`);
    this.instances.delete(name);

    for (const [threadId, binding] of this.threadBindings) {
      if (binding.instanceName === name) {
        this.threadBindings.delete(threadId);
      }
    }
  }

  list(): Instance[] {
    return Array.from(this.instances.values());
  }

  getInstance(name: string): Instance | null {
    return this.instances.get(name) ?? null;
  }

  bind(threadId: string, instanceName: string, sessionId: string): void {
    this.threadBindings.set(threadId, { instanceName, sessionId });
  }

  unbind(threadId: string): void {
    this.threadBindings.delete(threadId);
  }

  getBinding(
    threadId: string,
  ): { instance: Instance; sessionId: string } | null {
    const binding = this.threadBindings.get(threadId);
    if (!binding) {
      return null;
    }
    const instance = this.instances.get(binding.instanceName);
    if (!instance) {
      return null;
    }
    return { instance, sessionId: binding.sessionId };
  }

  findThreadByInstanceSession(
    instanceName: string,
    sessionId: string,
  ): string | null {
    for (const [threadId, binding] of this.threadBindings) {
      if (
        binding.instanceName === instanceName &&
        binding.sessionId === sessionId
      ) {
        return threadId;
      }
    }
    return null;
  }
}
