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
  sessionId: string;
  permissionID: string;
  tool: string;
  details?: { command?: string };
};

type PartProps = {
  sessionId: string;
  text?: string;
  delta?: { text?: string };
  part?: { text?: string };
};

type SessionProps = { sessionId: string };

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

export function createMessageRouter({
  instanceManager,
  openCodeClient,
  sendReply,
  streamThrottleMs = 1000,
}: {
  instanceManager: InstanceManagerLike;
  openCodeClient: OpenCodeClientLike;
  sendReply: (targetId: string, text: string) => void;
  streamThrottleMs?: number;
}) {
  const pendingByThread = new Map<
    string,
    { instanceName: string; sessionId: string; permissionId: string }
  >();
  const streamBuffers = new Map<string, { text: string; lastSentAt: number }>();

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
    const threadId = instanceManager.findThreadByInstanceSession(
      instanceName,
      props.sessionId,
    );
    if (!threadId) {
      return;
    }
    pendingByThread.set(threadId, {
      instanceName,
      sessionId: props.sessionId,
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
      streamBuffers.set(sessionId, { text: '', lastSentAt: 0 });
    }
    return streamBuffers.get(sessionId)!;
  }

  async function handleStreamingUpdate(
    instanceName: string,
    props: PartProps,
  ): Promise<void> {
    const threadId = instanceManager.findThreadByInstanceSession(
      instanceName,
      props.sessionId,
    );
    if (!threadId) {
      return;
    }
    const text = extractTextFromPart(props);
    if (!text) {
      return;
    }
    const buffer = getStreamBuffer(props.sessionId);
    buffer.text = text;
    const now = Date.now();
    if (now - buffer.lastSentAt < streamThrottleMs) {
      return;
    }
    buffer.lastSentAt = now;
    sendReply(threadId, buffer.text);
  }

  async function handleSessionComplete(
    instanceName: string,
    props: SessionProps,
  ): Promise<void> {
    const threadId = instanceManager.findThreadByInstanceSession(
      instanceName,
      props.sessionId,
    );
    if (!threadId) {
      return;
    }
    const buffer = streamBuffers.get(props.sessionId);
    if (buffer?.text) {
      sendReply(threadId, buffer.text);
    }
    streamBuffers.delete(props.sessionId);
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
      case 'part.updated':
        await handleStreamingUpdate(
          instanceName,
          data.properties as PartProps,
        );
        break;
      case 'session.completed':
        await handleSessionComplete(
          instanceName,
          data.properties as SessionProps,
        );
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
