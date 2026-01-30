type InstanceSummary = {
  port: number;
  name?: string;
  directory?: string;
  tmuxSession?: string;
};

type Binding = { instance: InstanceSummary; sessionId: string };

type InstanceManagerLike = {
  getBinding: (threadId: string) => Binding | null;
  getInstance: (name: string) => InstanceSummary | null;
  findThreadByInstanceSession: (
    instanceName: string,
    sessionId: string,
  ) => string | null;
};

type OpenCodeClientLike = {
  sendMessage: (port: number, sessionId: string, text: string) => Promise<void>;
  respondPermission: (
    port: number,
    sessionId: string,
    permissionId: string,
    allow: boolean,
  ) => Promise<void>;
};

type PermissionProps = {
  sessionId?: string;
  sessionID?: string;
  permissionID: string;
  tool: string;
  details?: { command?: string };
};

type PartProps = {
  sessionId?: string;
  sessionID?: string;
  messageId?: string;
  messageID?: string;
  text?: string;
  delta?: { text?: string };
  part?: { text?: string };
};

type SessionProps = { sessionId: string };

type MessageInfoProps = {
  info?: {
    id?: string;
    role?: string;
    sessionId?: string;
    sessionID?: string;
  };
};

type MessagePartProps = {
  part?: {
    id?: string;
    type?: string;
    text?: string;
    messageId?: string;
    messageID?: string;
    sessionId?: string;
    sessionID?: string;
  };
};

function isApproval(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return ['y', 'yes', '确认', '是'].includes(normalized);
}

function isRejection(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return ['n', 'no', '拒绝', '否'].includes(normalized);
}

function extractTextFromPart(properties: PartProps | null | undefined): string {
  if (!properties) {
    return '';
  }
  if (typeof properties.text === 'string') {
    return properties.text;
  }
  if (typeof properties.delta?.text === 'string') {
    return properties.delta.text;
  }
  if (typeof properties.part?.text === 'string') {
    return properties.part.text;
  }
  return '';
}

function extractSessionId(
  properties:
    | PermissionProps
    | PartProps
    | SessionProps
    | MessageInfoProps
    | MessagePartProps
    | null
    | undefined,
): string | null {
  const p = properties as
    | {
        sessionId?: unknown;
        sessionID?: unknown;
        info?: { sessionId?: unknown; sessionID?: unknown };
        part?: { sessionId?: unknown; sessionID?: unknown };
      }
    | undefined;

  const candidates = [
    p?.sessionId,
    p?.sessionID,
    p?.info?.sessionId,
    p?.info?.sessionID,
    p?.part?.sessionId,
    p?.part?.sessionID,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return null;
}

export function createMessageRouter({
  instanceManager,
  openCodeClient,
  sendReply,
  sendStreamReply,
  clearStreamSession,
  deleteStreamPreview,
  streamThrottleMs = 1500,
}: {
  instanceManager: InstanceManagerLike;
  openCodeClient: OpenCodeClientLike;
  sendReply: (targetId: string, text: string) => void;
  sendStreamReply?: (targetId: string, sessionKey: string, text: string) => void;
  clearStreamSession?: (sessionKey: string) => void;
  deleteStreamPreview?: (sessionKey: string) => Promise<void>;
  streamThrottleMs?: number;
}) {
  const pendingByThread = new Map<
    string,
    { instanceName: string; sessionId: string; permissionId: string }
  >();
  const streamBuffers = new Map<
    string,
    { text: string; lastSentAt: number; sentLength: number }
  >();
  const streamSourceBySession = new Map<string, 'part' | 'messagePart'>();
  const messageRoleById = new Map<string, string>();

  async function handleChatMessage({
    chatId,
    threadId,
    text,
  }: {
    chatId?: string | null;
    threadId: string;
    text: string;
  }): Promise<void> {
    const binding = instanceManager.getBinding(threadId);
    const targetId = threadId ?? chatId ?? threadId;
    if (!binding) {
      sendReply(targetId, '⚠️ 未绑定实例，请使用 /instances 查看或 /spawn 创建');
      return;
    }
    await openCodeClient.sendMessage(
      binding.instance.port,
      binding.sessionId,
      text,
    );
  }

  async function handlePermissionRequest(
    instanceName: string,
    props: PermissionProps,
  ): Promise<void> {
    const sessionId = extractSessionId(props);
    if (!sessionId) {
      return;
    }
    const threadId = instanceManager.findThreadByInstanceSession(
      instanceName,
      sessionId,
    );
    if (!threadId) {
      return;
    }
    pendingByThread.set(threadId, {
      instanceName,
      sessionId,
      permissionId: props.permissionID,
    });
    const details = props.details?.command
      ? `\n\n${props.details.command}`
      : '';
    sendReply(threadId, `⚠️ 需要确认: ${props.tool}${details}`);
  }

  async function handleUserConfirmation(
    threadId: string,
    response: string,
  ): Promise<boolean> {
    const pending = pendingByThread.get(threadId);
    if (!pending) {
      return false;
    }
    if (!isApproval(response) && !isRejection(response)) {
      return false;
    }
    const instance = instanceManager.getInstance(pending.instanceName);
    if (!instance) {
      pendingByThread.delete(threadId);
      return false;
    }
    await openCodeClient.respondPermission(
      instance.port,
      pending.sessionId,
      pending.permissionId,
      isApproval(response),
    );
    pendingByThread.delete(threadId);
    return true;
  }

  function getStreamBuffer(sessionId: string) {
    if (!streamBuffers.has(sessionId)) {
      // Clear any stale streaming message from previous session to ensure fresh messageId
      clearStreamSession?.(sessionId);
      streamBuffers.set(sessionId, { text: '', lastSentAt: Date.now(), sentLength: 0 });
    }
    return streamBuffers.get(sessionId)!;
  }

  function applyStreamText(buffer: { text: string }, fragment: string): void {
    if (!fragment) {
      return;
    }
    const prev = buffer.text;
    if (!prev || fragment.startsWith(prev)) {
      buffer.text = fragment;
      return;
    }
    if (prev.endsWith(fragment)) {
      return;
    }
    buffer.text = prev + fragment;
  }

  async function handleStreamingUpdate(
    instanceName: string,
    props: PartProps,
    sessionIdOverride?: string | null,
  ): Promise<void> {
    const sessionId = sessionIdOverride ?? extractSessionId(props);
    if (!sessionId) {
      return;
    }
    const threadId = instanceManager.findThreadByInstanceSession(instanceName, sessionId);
    if (!threadId) {
      return;
    }
    const fragment = extractTextFromPart(props);
    if (!fragment) {
      return;
    }
    const buffer = getStreamBuffer(sessionId);
    applyStreamText(buffer, fragment);
    // Throttled streaming: send/edit message at intervals
    const now = Date.now();
    if (now - buffer.lastSentAt < streamThrottleMs) {
      return;
    }
    if (!buffer.text) {
      return;
    }
    buffer.lastSentAt = now;
    buffer.sentLength = buffer.text.length;
    if (sendStreamReply) {
      sendStreamReply(threadId, sessionId, buffer.text);
    } else {
      sendReply(threadId, buffer.text);
    }
  }

  async function handleSessionComplete(
    instanceName: string,
    props: SessionProps,
  ): Promise<void> {
    const sessionId = extractSessionId(props);
    if (!sessionId) {
      return;
    }
    const threadId = instanceManager.findThreadByInstanceSession(
      instanceName,
      sessionId,
    );
    if (!threadId) {
      return;
    }
    const buffer = streamBuffers.get(sessionId);
    const fullText = buffer?.text ?? '';
    const wasTruncated = buffer && buffer.sentLength > 0 && fullText.length > 2000;

    if (wasTruncated && deleteStreamPreview) {
      // B1: Delete preview message and send full content (may be chunked)
      await deleteStreamPreview(sessionId);
      if (fullText) {
        sendReply(threadId, fullText);
      }
    } else if (fullText && fullText.length > (buffer?.sentLength ?? 0)) {
      // Just send remaining unsent content
      if (sendStreamReply) {
        sendStreamReply(threadId, sessionId, fullText);
      } else {
        sendReply(threadId, fullText);
      }
      clearStreamSession?.(sessionId);
    } else {
      clearStreamSession?.(sessionId);
    }

    streamBuffers.delete(sessionId);
    streamSourceBySession.delete(sessionId);
  }

  async function handleSseEvent(
    instanceName: string,
    data: { type?: string; properties?: unknown },
  ): Promise<void> {
    switch (data.type) {
      case 'permission.requested':
        await handlePermissionRequest(
          instanceName,
          data.properties as PermissionProps,
        );
        break;
      case 'part.updated': {
        const props = data.properties as PartProps;
        const sessionId = extractSessionId(props);
        if (sessionId && streamSourceBySession.get(sessionId) === 'messagePart') {
          break;
        }
        if (sessionId) {
          streamSourceBySession.set(sessionId, 'part');
        }
        await handleStreamingUpdate(
          instanceName,
          props,
          sessionId,
        );
        break;
      }
      case 'message.updated': {
        const props = data.properties as MessageInfoProps;
        const id = props?.info?.id;
        const role = props?.info?.role;
        if (typeof id === 'string' && id.trim() && typeof role === 'string' && role.trim()) {
          messageRoleById.set(id, role);
        }
        break;
      }
      case 'message.part.updated': {
        const props = data.properties as MessagePartProps;
        const part = props?.part;
        const messageId = typeof part?.messageID === 'string' ? part.messageID : part?.messageId;
        if (!messageId) {
          break;
        }
        const role = messageRoleById.get(messageId);
        if (role !== 'assistant') {
          break;
        }
        if (part?.type !== 'text') {
          break;
        }
        const sessionId = extractSessionId(part as unknown as SessionProps);
        if (sessionId) {
          streamSourceBySession.set(sessionId, 'messagePart');
        }
        await handleStreamingUpdate(instanceName, {
          sessionID: part.sessionID,
          sessionId: part.sessionId,
          text: part.text,
        }, sessionId);
        break;
      }
      case 'session.completed':
        await handleSessionComplete(
          instanceName,
          data.properties as SessionProps,
        );
        break;
      // session.idle and session.status are NOT used for B1 completion
      // They fire multiple times during streaming and would cause duplicates
      case 'session.idle':
      case 'session.status':
        // No-op: wait for session.completed only
        break;
      default:
        break;
    }
  }

  return {
    handleChatMessage,
    handlePermissionRequest,
    handleUserConfirmation,
    handleSseEvent,
  };
}
