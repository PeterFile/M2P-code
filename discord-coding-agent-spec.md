# Discord Coding Agent 技术规格书

> 基于 Clawdbot Gateway + OpenCode API + tmux 的远程对话式编程环境

---

## 1. 架构概述

### 1.1 设计目标

构建一个通过 Discord 聊天界面驱动本地 AI 编程代理的系统，实现：

- **本地优先 (Local-First)**：代码与计算在本地 WSL 环境执行，保障隐私
- **会话持久化**：利用 tmux 实现断连后任务继续执行
- **结构化交互**：通过 OpenCode HTTP API 获得可靠的输入输出
- **安全确认机制**：高危操作需人工通过 Discord 确认

### 1.2 系统拓扑

```
┌─────────────────────────────────────────────────────────────────┐
│  Discord Cloud                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  #coding-agent                                            │  │
│  │  ├── Thread: "Backend Work"  → instance:4096              │  │
│  │  ├── Thread: "Frontend Bug"  → instance:4097              │  │
│  │  └── Slash Commands: /instances, /spawn, /connect, /kill  │  │
│  └───────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬─────────────────────────────────┘
                                │ Discord Gateway Protocol
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Windows Host                                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Clawdbot Gateway                                         │  │
│  │  - WebSocket Server (:18789)                              │  │
│  │  - Discord Bot Integration                                │  │
│  │  - Message Routing & Auth                                 │  │
│  └───────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬─────────────────────────────────┘
                                │ WebSocket (ws://host.wsl:18789)
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  WSL2 Linux Environment                                         │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Synapse Bridge (Node.js Daemon)                          │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │  Protocol Adapter    │ Instance Manager            │  │  │
│  │  │  - Clawdbot WS       │ - Thread ↔ Instance Mapping │  │  │
│  │  │  - Multi HTTP Client │ - tmux Session Lifecycle    │  │  │
│  │  │  - Multi SSE Sub     │ - Port Allocation           │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                          │                                      │
│         ┌────────────────┼────────────────┐                     │
│         ▼                ▼                ▼                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ tmux:       │  │ tmux:       │  │ tmux:       │              │
│  │ backend-api │  │ frontend    │  │ docs        │              │
│  │ :4096       │  │ :4097       │  │ :4098       │              │
│  │ /projects/  │  │ /projects/  │  │ /projects/  │              │
│  │   api/      │  │   web/      │  │   docs/     │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│        ↑                ↑                ↑                      │
│        └────────────────┴────────────────┘                      │
│              每个实例独立的 OpenCode serve                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心组件规格

### 2.1 Clawdbot Gateway

**角色**：Discord 消息网关，负责协议转换与身份验证

**关键配置** (`clawdbot.json`):

```json
{
  "gateway": {
    "bind": "0.0.0.0",
    "port": 18789,
    "auth": {
      "token": "${CLAWDBOT_GATEWAY_TOKEN}"
    }
  },
  "channels": {
    "discord": {
      "enabled": true,
      "token": "${DISCORD_BOT_TOKEN}",
      "groupPolicy": "allowlist",
      "guilds": {
        "${GUILD_ID}": {
          "requireMention": false,
          "users": ["${ALLOWED_USER_ID}"],
          "channels": {
            "coding-agent": { "allow": true }
          }
        }
      }
    }
  },
  "commands": {
    "native": "auto",
    "text": true,
    "useAccessGroups": true
  }
}
```

**WebSocket 协议**：

| 事件类型    | 方向            | 用途                 |
| ----------- | --------------- | -------------------- |
| `connect`   | Client → Server | 握手鉴权             |
| `chat`      | Server → Client | 接收用户消息         |
| `chat.send` | Client → Server | 发送回复（需幂等键） |
| `presence`  | Server → Client | 在线状态             |

### 2.2 OpenCode Serve Mode

**角色**：AI 编程代理，提供结构化 API

**启动命令**：

```bash
tmux new-session -d -s opencode-main \
  'opencode serve --port 4096 --hostname 0.0.0.0'
```

**关键 API 端点**：

| 端点                                     | 方法      | 用途               |
| ---------------------------------------- | --------- | ------------------ |
| `/session`                               | GET       | 列出所有 sessions  |
| `/session`                               | POST      | 创建新 session     |
| `/session/:id`                           | GET       | 获取 session 详情  |
| `/session/:id/message`                   | POST      | 发送消息到 session |
| `/session/:id/permissions/:permissionID` | POST      | 响应权限请求       |
| `/event`                                 | GET (SSE) | 订阅实时事件流     |

**SSE 事件类型**：

```javascript
// 订阅示例
const eventSource = new EventSource("http://localhost:4096/event");

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);

  switch (data.type) {
    case "session.created":
      // 新 session 创建
      break;
    case "message.created":
      // AI 开始响应
      break;
    case "part.updated":
      // 流式输出更新
      break;
    case "permission.requested":
      // 需要用户确认
      break;
    case "session.completed":
      // 任务完成
      break;
  }
};
```

**权限配置** (`opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "allow",
    "bash": "ask",
    "question": "allow"
  }
}
```

### 2.3 tmux 会话容器

**角色**：进程持久化与人工干预入口

**核心配置** (`~/.tmux.conf`):

```bash
# 增大历史缓冲区
set -g history-limit 50000

# 关闭状态栏简化输出
set -g status off

# 启用鼠标支持（可选）
set -g mouse on
```

**管理命令**：

```bash
# 创建后台 session
tmux new-session -d -s opencode-main 'opencode serve --port 4096'

# 查看运行状态
tmux ls

# 人工接入
tmux attach -t opencode-main

# 重启崩溃的 pane
tmux respawn-pane -t opencode-main
```

---

## 3. Synapse Bridge 设计

### 3.1 模块架构

```
┌─────────────────────────────────────────────────────────────────┐
│  Synapse Bridge                                                 │
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────────────────────────┐   │
│  │  Clawdbot       │  │  Instance Manager                   │   │
│  │  Adapter        │  │                                     │   │
│  │  - WS Conn      │  │  instances: Map<name, {             │   │
│  │  - Reconnect    │  │    port: number,                    │   │
│  │  - Auth         │  │    directory: string,               │   │
│  │                 │  │    tmuxSession: string,             │   │
│  └────────┬────────┘  │    sseClient: EventSource           │   │
│           │           │  }>                                 │   │
│           │           │                                     │   │
│           │           │  threadBindings: Map<threadId, {    │   │
│           │           │    instanceName: string,            │   │
│           │           │    sessionId: string                │   │
│           │           │  }>                                 │   │
│           │           └─────────────────────────────────────┘   │
│           │                          │                          │
│           └──────────────────────────┘                          │
│                          │                                      │
│                          ▼                                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Command Handler                                          │  │
│  │                                                           │  │
│  │  /instances            → 列出所有运行中的实例              │  │
│  │  /spawn <name> <dir>   → 创建新实例 (tmux + opencode)     │  │
│  │  /connect <name>       → 绑定当前 Thread 到实例            │  │
│  │  /disconnect           → 解绑当前 Thread                   │  │
│  │  /kill <name>          → 终止实例 (关闭 tmux session)      │  │
│  │  /status               → 显示当前绑定状态                  │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Slash Command 规格

| 命令          | 参数                   | 行为                                                         | 示例                                     |
| ------------- | ---------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| `/instances`  | 无                     | 列出所有运行中的 OpenCode 实例                               | `/instances`                             |
| `/spawn`      | `<name>` `<directory>` | 创建新实例：分配端口、启动 tmux session、启动 opencode serve | `/spawn backend /home/user/projects/api` |
| `/connect`    | `<name>`               | 将当前 Thread 绑定到指定实例                                 | `/connect backend`                       |
| `/disconnect` | 无                     | 解绑当前 Thread                                              | `/disconnect`                            |
| `/kill`       | `<name>`               | 终止实例：关闭 tmux session                                  | `/kill backend`                          |
| `/status`     | 无                     | 显示当前 Thread 绑定状态                                     | `/status`                                |
| `/attach`     | `<name>`               | 显示 SSH 接入命令（人工干预用）                              | `/attach backend`                        |

### 3.3 Instance Manager 实现

```typescript
interface Instance {
  name: string;
  port: number;
  directory: string;
  tmuxSession: string;
  sseClient: EventSource | null;
}

class InstanceManager {
  private instances: Map<string, Instance> = new Map();
  private threadBindings: Map<
    string,
    { instanceName: string; sessionId: string }
  > = new Map();
  private nextPort = 4096;

  // 创建新实例
  async spawn(name: string, directory: string): Promise<Instance> {
    if (this.instances.has(name)) {
      throw new Error(`Instance '${name}' already exists`);
    }

    const port = this.nextPort++;
    const tmuxSession = `opencode-${name}`;

    // 启动 tmux session + opencode serve
    await exec(`tmux new-session -d -s ${tmuxSession} -c ${directory} \
      'opencode serve --port ${port} --hostname 0.0.0.0'`);

    // 等待服务启动
    await this.waitForHealth(`http://localhost:${port}`);

    // 订阅 SSE 事件
    const sseClient = new EventSource(`http://localhost:${port}/event`);
    this.setupSSEHandlers(name, sseClient);

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

  // 终止实例
  async kill(name: string): Promise<void> {
    const instance = this.instances.get(name);
    if (!instance) throw new Error(`Instance '${name}' not found`);

    instance.sseClient?.close();
    await exec(`tmux kill-session -t ${instance.tmuxSession}`);
    this.instances.delete(name);

    // 清理绑定到该实例的 Thread
    for (const [threadId, binding] of this.threadBindings) {
      if (binding.instanceName === name) {
        this.threadBindings.delete(threadId);
      }
    }
  }

  // 列出所有实例
  list(): Instance[] {
    return Array.from(this.instances.values());
  }

  // 绑定 Thread 到实例
  bind(threadId: string, instanceName: string, sessionId: string): void {
    this.threadBindings.set(threadId, { instanceName, sessionId });
  }

  // 获取 Thread 绑定的实例
  getBinding(
    threadId: string,
  ): { instance: Instance; sessionId: string } | null {
    const binding = this.threadBindings.get(threadId);
    if (!binding) return null;

    const instance = this.instances.get(binding.instanceName);
    if (!instance) return null;

    return { instance, sessionId: binding.sessionId };
  }
}
```

### 3.4 消息路由逻辑

```typescript
async function handleMessage(event: ClawdbotChatEvent) {
  const { chatId, threadId, text } = event.payload;

  // 1. 检查是否为 Slash Command
  if (text.startsWith("/")) {
    return handleSlashCommand(text, threadId, chatId);
  }

  // 2. 查找 Thread 绑定的实例
  const binding = instanceManager.getBinding(threadId);
  if (!binding) {
    return sendReply(
      chatId,
      "⚠️ 未绑定实例，请使用 /instances 查看或 /spawn 创建",
    );
  }

  // 3. 发送消息到对应实例的 OpenCode
  const { instance, sessionId } = binding;
  await fetch(
    `http://localhost:${instance.port}/session/${sessionId}/message`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
    },
  );

  // 4. 响应通过 SSE 异步推送
}
```

### 3.5 权限确认流程

```typescript
// 为每个实例设置 SSE 事件处理
function setupSSEHandlers(instanceName: string, sseClient: EventSource) {
  sseClient.onmessage = async (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
      case "permission.requested":
        await handlePermissionRequest(instanceName, data.properties);
        break;
      case "part.updated":
        await handleStreamingUpdate(instanceName, data.properties);
        break;
      case "session.completed":
        await handleSessionComplete(instanceName, data.properties);
        break;
    }
  };
}

async function handlePermissionRequest(
  instanceName: string,
  props: {
    sessionId: string;
    permissionID: string;
    tool: string;
    details: any;
  },
) {
  const { sessionId, permissionID, tool, details } = props;

  // 查找绑定到该 session 的 Thread
  const threadId = findThreadByInstanceSession(instanceName, sessionId);
  if (!threadId) return;

  // 发送确认请求到 Discord
  await sendReply(threadId, formatPermissionRequest(tool, details));

  // 存入待确认队列
  pendingPermissions.set(permissionID, { instanceName, sessionId, threadId });
}

async function handleUserConfirmation(threadId: string, response: string) {
  const pending = findPendingByThread(threadId);
  if (!pending) return;

  const instance = instanceManager.instances.get(pending.instanceName);
  if (!instance) return;

  const isApproved = ["y", "yes", "确认", "是"].includes(
    response.toLowerCase(),
  );

  await fetch(
    `http://localhost:${instance.port}/session/${pending.sessionId}/permissions/${pending.permissionID}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response: isApproved ? "allow" : "deny",
        remember: false,
      }),
    },
  );

  pendingPermissions.delete(pending.permissionID);
}
```

---

## 4. 交互流程

### 4.1 创建实例

```
User: /instances

Bot:
📋 **运行中的实例**

| 名称 | 端口 | 工作目录 | tmux Session |
|------|------|----------|---------------|
| (无运行中的实例) |

使用 `/spawn <name> <directory>` 创建新实例

────────────────────────────────────────

User: /spawn backend /home/user/projects/api

Bot:
🚀 **正在创建实例...**

────────────────────────────────────────

Bot:
✅ **实例已创建**
- 名称: `backend`
- 端口: `4096`
- 工作目录: `/home/user/projects/api`
- tmux Session: `opencode-backend`

使用 `/connect backend` 绑定到此实例
人工接入: `tmux attach -t opencode-backend`

────────────────────────────────────────

User: /connect backend

Bot:
✅ **已连接到实例 `backend`**
现在可以直接发送消息与 AI 交互
```

### 4.2 正常对话

````
User: 重构 login 函数，使用新的 auth schema

Bot:
🤖 **处理中...**

────────────────────────────────────────

Bot:
我已分析了 `auth.py` 的当前实现。计划进行以下修改：

1. 更新 `login()` 函数签名
2. 引入新的 `AuthSchema` 类型
3. 添加 token 验证逻辑

```diff
- def login(username: str, password: str) -> bool:
+ def login(credentials: AuthCredentials) -> AuthResult:
````

是否继续执行？

```

### 4.3 权限确认

```

Bot:
⚠️ **需要确认**

AI 请求执行以下命令：

```bash
git commit -m "refactor: update login function with new auth schema"
```

回复 **Y** 确认执行，或 **N** 拒绝

────────────────────────────────────────

User: Y

Bot:
✅ 已执行

```
[main 3a2b1c0] refactor: update login function with new auth schema
 1 file changed, 15 insertions(+), 8 deletions(-)
```

````

---

## 5. 部署配置

### 5.1 网络配置

**WSL2 网络模式**（推荐 Windows 11 22H2+）:

```ini
# %USERPROFILE%\.wslconfig
[wsl2]
networkingMode=mirrored
````

> 启用后，WSL 内的 `localhost` 直接映射到 Windows `localhost`

**备选方案**（旧版 Windows）:

```bash
# 获取 Windows Host IP
HOST_IP=$(cat /etc/resolv.conf | grep nameserver | awk '{print $2}')

# 连接 Clawdbot
ws://${HOST_IP}:18789
```

### 5.2 启动脚本

```bash
#!/bin/bash
# start-coding-agent.sh

# 仅启动 Synapse Bridge
# OpenCode 实例由 /spawn 命令按需创建

cd /opt/synapse-bridge
node dist/index.js &

echo "✅ Synapse Bridge 已启动"
echo "   等待用户通过 Discord 创建实例"
echo "   使用 /spawn <name> <directory> 创建新实例"
```

**预创建常用实例（可选）**：

```bash
#!/bin/bash
# start-with-defaults.sh

# 启动 Synapse Bridge
cd /opt/synapse-bridge
node dist/index.js &

# 预创建常用项目实例
tmux new-session -d -s opencode-backend \
  -c /home/user/projects/api \
  'opencode serve --port 4096 --hostname 0.0.0.0'

tmux new-session -d -s opencode-frontend \
  -c /home/user/projects/web \
  'opencode serve --port 4097 --hostname 0.0.0.0'

echo "✅ Coding Agent 已启动"
echo "   实例:"
echo "     - backend  → :4096 → /projects/api"
echo "     - frontend → :4097 → /projects/web"
```

### 5.3 Systemd 服务（可选）

```ini
# /etc/systemd/user/synapse-bridge.service
[Unit]
Description=Synapse Bridge for Discord Coding Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/synapse-bridge
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

---

## 6. 安全规范

### 6.1 多层防御

| 层级       | 措施                   | 实现                              |
| ---------- | ---------------------- | --------------------------------- |
| **接入层** | Discord 用户白名单     | Clawdbot `allowFrom` 配置         |
| **传输层** | WSL ↔ Windows 通信加密 | 使用 WSS 或 SSH 隧道              |
| **执行层** | 危险命令二次确认       | OpenCode `permission.bash: "ask"` |
| **网络层** | 限制出站流量           | Tailscale ACL / iptables          |

### 6.2 敏感信息处理

```typescript
// 日志脱敏
function sanitizeLog(message: string): string {
  return message
    .replace(/token[=:]\s*\S+/gi, "token=***REDACTED***")
    .replace(/password[=:]\s*\S+/gi, "password=***REDACTED***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***REDACTED***");
}
```

---

## 7. 故障处理

### 7.1 连接中断

| 场景             | 检测方式                 | 恢复策略            |
| ---------------- | ------------------------ | ------------------- |
| Clawdbot WS 断开 | WebSocket `close` 事件   | 指数退避重连        |
| OpenCode 崩溃    | HTTP 请求超时            | `tmux respawn-pane` |
| SSE 流中断       | EventSource `error` 事件 | 重新订阅 `/event`   |

### 7.2 状态恢复

```typescript
async function recoverState() {
  // 1. 重新获取 session 列表
  const sessions = await opencode.get("/session");

  // 2. 恢复 Thread-Session 映射（从持久化存储）
  const savedMappings = await loadMappingsFromDisk();

  // 3. 验证 session 仍然存在
  for (const [threadId, binding] of savedMappings) {
    if (sessions.find((s) => s.id === binding.sessionId)) {
      threadSessionMap.set(threadId, binding);
    }
  }

  // 4. 重新订阅 SSE
  subscribeToEvents();
}
```

---

## 8. 未来扩展

- **多模态支持**：Discord 图片 → OpenCode 分析
- **语音指令**：集成 Clawdbot 语音能力
- **多 Agent 协同**：多个 OpenCode 实例并行任务
- **Web Dashboard**：可视化 session 管理界面

---

## 附录 A: 技术栈

| 组件         | 技术选型          | 版本要求 |
| ------------ | ----------------- | -------- |
| 消息网关     | Clawdbot Gateway  | Latest   |
| AI 代理      | OpenCode          | Latest   |
| 会话容器     | tmux              | 3.0+     |
| 中间件运行时 | Node.js           | 20 LTS   |
| 操作系统     | Windows 11 + WSL2 | 22H2+    |

## 附录 B: 参考资料

- [Clawdbot Documentation](https://docs.clawd.bot)
- [OpenCode Server API](https://opencode.ai/docs/server)
- [tmux Wiki](https://github.com/tmux/tmux/wiki)
