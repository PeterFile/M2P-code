type InstanceSummary = {
  name: string;
  port: number;
  directory: string;
  tmuxSession: string;
};

type InstanceManagerLike = {
  list: () => InstanceSummary[];
  spawn: (name: string, directory: string) => Promise<InstanceSummary>;
  getInstance: (name: string) => InstanceSummary | null;
  kill: (name: string) => Promise<void>;
  bind: (threadId: string, instanceName: string, sessionId: string) => void;
  unbind: (threadId: string) => void;
  getBinding: (
    threadId: string,
  ) => { instance: InstanceSummary; sessionId: string } | null;
};

type OpenCodeClientLike = {
  createSession?: (port: number) => Promise<{ id: string }>;
};

type SlashContext = {
  chatId?: string | null;
  threadId: string;
  instanceManager: InstanceManagerLike;
  openCodeClient: OpenCodeClientLike;
};

function formatInstanceList(instances: InstanceSummary[]): string {
  if (instances.length === 0) {
    return '📋 无运行中的实例';
  }
  const lines = instances.map(
    (instance) => `- ${instance.name} :${instance.port} ${instance.directory}`,
  );
  return ['📋 运行中的实例', ...lines].join('\n');
}

export async function handleSlashCommand(
  text: string,
  context: SlashContext,
): Promise<{ handled: boolean; replyText: string }> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return { handled: false, replyText: '' };
  }

  const [command, ...args] = trimmed.split(/\s+/);
  const { instanceManager, openCodeClient, threadId } = context;

  switch (command) {
    case '/instances': {
      const instances = instanceManager.list();
      return { handled: true, replyText: formatInstanceList(instances) };
    }
    case '/spawn': {
      const name = args[0];
      const directory = args[1];
      if (!name || !directory) {
        return {
          handled: true,
          replyText: '用法: /spawn <name> <directory>',
        };
      }
      const instance = await instanceManager.spawn(name, directory);
      return {
        handled: true,
        replyText: `✅ 实例已创建: ${instance.name} :${instance.port} ${instance.directory}`,
      };
    }
    case '/connect': {
      const name = args[0];
      if (!name) {
        return { handled: true, replyText: '用法: /connect <name>' };
      }
      const instance = instanceManager.getInstance(name);
      if (!instance) {
        return { handled: true, replyText: `未找到实例: ${name}` };
      }
      if (!openCodeClient?.createSession) {
        throw new Error('OpenCode client missing createSession');
      }
      const session = await openCodeClient.createSession(instance.port);
      instanceManager.bind(threadId, name, session.id);
      return {
        handled: true,
        replyText: `✅ 已连接到实例 ${name} (session ${session.id})`,
      };
    }
    case '/disconnect': {
      instanceManager.unbind(threadId);
      return { handled: true, replyText: '✅ 已解绑当前线程' };
    }
    case '/status': {
      const binding = instanceManager.getBinding(threadId);
      if (!binding) {
        return { handled: true, replyText: '⚠️ 未绑定实例' };
      }
      return {
        handled: true,
        replyText: `✅ 当前绑定: ${binding.instance.name} (session ${binding.sessionId})`,
      };
    }
    case '/kill': {
      const name = args[0];
      if (!name) {
        return { handled: true, replyText: '用法: /kill <name>' };
      }
      await instanceManager.kill(name);
      return { handled: true, replyText: `✅ 实例已终止: ${name}` };
    }
    case '/attach': {
      const name = args[0];
      if (!name) {
        return { handled: true, replyText: '用法: /attach <name>' };
      }
      const instance = instanceManager.getInstance(name);
      if (!instance) {
        return { handled: true, replyText: `未找到实例: ${name}` };
      }
      return {
        handled: true,
        replyText: `tmux attach -t ${instance.tmuxSession}`,
      };
    }
    default:
      return { handled: true, replyText: `未知命令: ${command}` };
  }
}
