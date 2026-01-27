import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';
import type { Dispatcher } from 'undici';
import type { Agent as HttpAgent } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import { ProxyAgent } from 'proxy-agent';

export function installProxySupportFromEnv(): void {
  // Make Node's built-in fetch/undici respect HTTP(S)_PROXY/NO_PROXY.
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent() as Dispatcher);
  } catch {
    // Best-effort.
  }

  // Some deps still use Node's `http(s)` stack (incl. WS upgrade). Use proxy-agent so
  // `HTTP(S)_PROXY/ALL_PROXY/NO_PROXY` works consistently across transports.
  try {
    const agent = new ProxyAgent() as unknown as HttpAgent;
    (http as unknown as { globalAgent: HttpAgent }).globalAgent = agent;
    (https as unknown as { globalAgent: HttpAgent }).globalAgent = agent;
  } catch {
    // Best-effort.
  }
}
