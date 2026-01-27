type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function assertOk(res: Response, url: string): void {
  if (!res.ok) {
    const status = res.status ?? 'unknown';
    throw new Error(`OpenCode request failed (${status}) ${url}`);
  }
}

export function createOpenCodeClient({ fetch = globalThis.fetch as FetchLike } = {}) {
  async function createSession(port: number): Promise<{ id: string }> {
    const url = `http://localhost:${port}/session`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assertOk(res, url);
    return res.json() as Promise<{ id: string }>;
  }

  async function sendMessage(
    port: number,
    sessionId: string,
    text: string,
  ): Promise<void> {
    const url = `http://localhost:${port}/session/${sessionId}/message`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
    });
    assertOk(res, url);
  }

  async function respondPermission(
    port: number,
    sessionId: string,
    permissionId: string,
    allow: boolean,
  ): Promise<void> {
    const url =
      `http://localhost:${port}/session/${sessionId}/permissions/${permissionId}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response: allow ? 'allow' : 'deny',
        remember: false,
      }),
    });
    assertOk(res, url);
  }

  async function listSessions(port: number): Promise<unknown> {
    const url = `http://localhost:${port}/session`;
    const res = await fetch(url, { method: 'GET' });
    assertOk(res, url);
    return res.json();
  }

  return {
    createSession,
    sendMessage,
    respondPermission,
    listSessions,
  };
}
