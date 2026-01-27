import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';
import type { Dispatcher } from 'undici';
import type { Agent as HttpAgent } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import { ProxyAgent } from 'proxy-agent';

export function installProxySupportFromEnv(): void {
  // Prefer uppercase env vars for deps that only read that form.
  const env = process.env as Record<string, string | undefined>;
  if (!env.HTTP_PROXY && env.http_proxy) env.HTTP_PROXY = env.http_proxy;
  if (!env.HTTPS_PROXY && env.https_proxy) env.HTTPS_PROXY = env.https_proxy;
  if (!env.NO_PROXY && env.no_proxy) env.NO_PROXY = env.no_proxy;

  if (!env.HTTP_PROXY && !env.HTTPS_PROXY) {
    const allProxy = env.ALL_PROXY ?? env.all_proxy;
    if (allProxy && /^https?:\/\//i.test(allProxy)) {
      env.HTTP_PROXY = allProxy;
      env.HTTPS_PROXY = allProxy;
    }
  }

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
