# Discord Coding Agent Bridge

## 你要做什么

把 Discord 频道/Thread 里的对话转成 OpenCode 任务，并在本机用 tmux 持久化运行。消息走向是：Discord → Synapse Bridge（本项目）→ OpenCode 实例。

## 安装本项目依赖

- Node.js 20 LTS+
- tmux 3+
- `opencode` 在 PATH 中

在仓库内执行：

```bash
npm install --cache /tmp/npm-cache
```

## 配置 Synapse Bridge

设置环境变量（最少要有 `DISCORD_BOT_TOKEN`）：

- `DISCORD_BOT_TOKEN`：Discord Bot Token（必填）
- `DISCORD_GUILD_ID`：只处理该 Guild（可选；建议填）
- `DISCORD_ALLOWED_USER_IDS`：允许的用户 ID（逗号分隔，可选）
- `DISCORD_ALLOWED_CHANNEL_IDS`：允许的频道 ID（逗号分隔；Thread 会按 parent 频道做匹配，可选）
- `DISCORD_REQUIRE_MENTION`：是否要求 @bot 才处理（默认 `false`）

- `BRIDGE_PORT_START`（默认 `4096`）
- `BRIDGE_OPENCODE_BIN`（默认 `opencode`）
- `BRIDGE_TMUX_BIN`（默认 `tmux`）
- `BRIDGE_STREAM_THROTTLE_MS`（默认 `1000`）
- `BRIDGE_OPENCODE_HOSTNAME`（默认 `0.0.0.0`）

### 环境变量怎么设置（zsh）

只对当前命令生效：

```bash
DISCORD_BOT_TOKEN='...' DISCORD_GUILD_ID='...' npm run dev
```

对当前 shell 会话生效：

```bash
export DISCORD_BOT_TOKEN='...'
export DISCORD_GUILD_ID='...'
export DISCORD_ALLOWED_USER_IDS='123,456'
export DISCORD_ALLOWED_CHANNEL_IDS='789'
npm run dev
```

用 `.env` 文件（避免把 token 写进 shell history）：

```bash
cat > .env <<'EOF'
DISCORD_BOT_TOKEN=...
DISCORD_GUILD_ID=...
DISCORD_ALLOWED_USER_IDS=...
DISCORD_ALLOWED_CHANNEL_IDS=...
EOF

set -a
source .env
set +a

npm run dev
```

🔒 **安全**：token 属于凭证，不要提交到 git，不要贴到公开渠道；泄露后立刻在 Discord Dev Portal 里重置。

### 代理 / 网络（可选，但常见）

如果你在本机直连 Discord 会超时（例如：`curl --noproxy '*' https://discord.com/api/v10/gateway` 超时），你必须让 Bridge 的 Node 进程走代理：

```bash
export HTTP_PROXY='http://127.0.0.1:7897'
export HTTPS_PROXY='http://127.0.0.1:7897'
export NO_PROXY='localhost,127.0.0.1,::1'
```

⚠️ 本项目使用 `undici` 的 `EnvHttpProxyAgent`（实验性 API）让 `fetch()` 尊重 `HTTP(S)_PROXY/NO_PROXY`；Discord Gateway 连接使用 `ws` + `proxy-agent`。

### Discord 侧必要开关

在 Discord Dev Portal → Bot → Privileged Gateway Intents：

- 开启 **Message Content Intent**（否则频道消息可能没有 content，Bot 会“没反应”）

启动 Bridge：

```bash
npm run dev
```

## 在 Discord 里使用

按以下顺序：

1. `/instances` 查看当前实例
2. `/spawn backend /path/to/project` 创建实例
3. `/connect backend` 绑定当前 Thread
4. 直接发送消息

### 权限确认

当 OpenCode 请求执行高危操作时，你会收到提示：

```
⚠️ 需要确认: bash

rm -rf /tmp
```

在同一 Thread 回复 `Y` 或 `N`。

## 为什么可行（技术要点）

- 每个实例在 tmux 中运行 `opencode serve`，确保断连后仍可继续执行。
- Bridge 使用 OpenCode HTTP API 创建 session，并通过 `/event` SSE 订阅流式输出与权限请求。
- Bridge 维护 `threadId -> instance/session` 映射，保证 Discord Thread 与 OpenCode session 一一对应。
- 权限请求从 OpenCode SSE 事件回传到 Discord，实现人工确认闭环。

## 安全提示

🔒 本项目会在本机执行 `tmux` 与 `opencode` 命令，并转发权限请求到 Discord。建议：

- 只允许可信人员进入频道
- 只用环境变量提供 token
- 首次运行先在受限目录测试

回滚方式：`/kill <name>` 或手动执行 `tmux kill-session -t opencode-<name>`。
