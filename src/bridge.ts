import { handleSlashCommand } from './command-handler.js';
import { createMessageRouter } from './message-router.js';

type GatewayClientLike = {
  connect: () => void;
  disconnect: () => void;
  sendMessage: (payload: { chatId: string; threadId?: string | null; text: string }) => void;
  sendOrEditMessage?: (payload: { chatId: string; threadId?: string | null; sessionKey: string; text: string }) => void;
  clearStreamingMessage?: (sessionKey: string) => void;
};

type InstanceSummary = {
  name: string;
  port: number;
  directory: string;
  tmuxSession: string;
};

type InstanceManagerLike = {
  list: () => InstanceSummary[];
  spawn: (name: string, directory: string) => Promise<InstanceSummary>;
  kill: (name: string) => Promise<void>;
  bind: (threadId: string, instanceName: string, sessionId: string) => void;
  unbind: (threadId: string) => void;
  getBinding: (
    threadId: string,
  ) => { instance: InstanceSummary; sessionId: string } | null;
  getInstance: (name: string) => InstanceSummary | null;
  findThreadByInstanceSession: (
    instanceName: string,
    sessionId: string,
  ) => string | null;
};

type OpenCodeClientLike = {
  createSession?: (port: number) => Promise<{ id: string }>;
  sendMessage: (port: number, sessionId: string, text: string) => Promise<void>;
  respondPermission: (
    port: number,
    sessionId: string,
    permissionId: string,
    allow: boolean,
  ) => Promise<void>;
};

export function createBridge({
  gatewayClient,
  instanceManager,
  openCodeClient,
  streamThrottleMs = 1000,
}: {
  gatewayClient: GatewayClientLike;
  instanceManager: InstanceManagerLike;
  openCodeClient: OpenCodeClientLike;
  streamThrottleMs?: number;
}) {
  const threadChatMap = new Map<string, string>();

  const sendReply = (targetId: string, text: string) => {
    const chatId = threadChatMap.get(targetId);
    if (chatId) {
      // targetId is threadId
      gatewayClient.sendMessage({ chatId, threadId: targetId, text });
      return;
    }
    // targetId is chatId (channel message, not a thread)
    gatewayClient.sendMessage({ chatId: targetId, text });
  };

  const sendStreamReply = (targetId: string, sessionKey: string, text: string) => {
    if (!gatewayClient.sendOrEditMessage) {
      // Fallback to regular send if streaming not supported
      sendReply(targetId, text);
      return;
    }
    const chatId = threadChatMap.get(targetId);
    if (chatId) {
      gatewayClient.sendOrEditMessage({ chatId, threadId: targetId, sessionKey, text });
      return;
    }
    gatewayClient.sendOrEditMessage({ chatId: targetId, sessionKey, text });
  };

  const clearStreamSession = (sessionKey: string) => {
    gatewayClient.clearStreamingMessage?.(sessionKey);
  };

  const router = createMessageRouter({
    instanceManager,
    openCodeClient,
    sendReply,
    sendStreamReply,
    clearStreamSession,
    streamThrottleMs,
  });

  async function handleChat(payload: {
    chatId?: string | null;
    threadId?: string | null;
    text: string;
  }): Promise<void> {
    const { chatId, threadId, text } = payload;
    const targetId = threadId ?? chatId ?? null;
    if (!targetId) {
      return;
    }
    if (threadId && chatId) {
      threadChatMap.set(threadId, chatId);
    }

    const commandResult = await handleSlashCommand(text, {
      chatId: chatId ?? undefined,
      threadId: targetId,
      instanceManager,
      openCodeClient,
    });

    if (commandResult.handled) {
      if (commandResult.replyText) {
        sendReply(targetId, commandResult.replyText);
      }
      return;
    }

    const consumed = await router.handleUserConfirmation(targetId, text);
    if (consumed) {
      sendReply(targetId, '✅ 已处理');
      return;
    }

    await router.handleChatMessage({ chatId, threadId: targetId, text });
  }

  return {
    handleChat,
    handleSseEvent: router.handleSseEvent,
    start() {
      gatewayClient.connect();
    },
    stop() {
      gatewayClient.disconnect();
    },
  };
}
