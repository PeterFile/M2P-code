# AGENTS.md

## 项目概览

- Synapse Bridge：监听 Discord 消息，把对话转为对 OpenCode 实例的 HTTP/SSE 调用，并用 tmux 管理实例生命周期。

## 运行前提

- Node.js 20 LTS
- tmux 3+
- `opencode` 可执行文件在 PATH 中

## 常用命令

- `npm install`
- `npm run dev`
- `npm test`

## 配置（环境变量）

- `DISCORD_BOT_TOKEN`：Discord Bot Token（必填）
- `DISCORD_GUILD_ID`：只处理该 Guild（可选）
- `DISCORD_ALLOWED_USER_IDS`：允许的用户 ID（逗号分隔，可选）
- `DISCORD_ALLOWED_CHANNEL_IDS`：允许的频道 ID（逗号分隔；Thread 按 parent 频道匹配，可选）
- `DISCORD_REQUIRE_MENTION`：是否要求 @bot 才处理（默认 `false`）
- `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`：如果你的网络需要代理才能访问 Discord，必须给 Bridge 进程设置（也可用小写 `http_proxy` 等）
- `BRIDGE_PORT_START`：实例起始端口（默认 `4096`）
- `BRIDGE_OPENCODE_BIN`：`opencode` 可执行文件（默认 `opencode`）
- `BRIDGE_TMUX_BIN`：`tmux` 可执行文件（默认 `tmux`）
- `BRIDGE_STREAM_THROTTLE_MS`：SSE 流式输出节流（默认 `1000`）
- `BRIDGE_OPENCODE_HOSTNAME`：OpenCode 监听地址（默认 `0.0.0.0`）

## 可复用要点

- 回复消息优先使用 `threadId`；如需回到频道，使用 Bridge 内缓存的 `threadId -> chatId` 映射。
- OpenCode 健康检查使用 `GET /session`，实例启动后必须先通过此检查再订阅 `/event`。
- TypeScript 使用 NodeNext + ESM，源文件 import 仍保留 `.js` 后缀以兼容构建输出。
- 开发/测试使用 `tsx`，构建使用 `tsc`。
- Discord 侧读取频道消息依赖 **Message Content Intent**；未开启时，Bot 可能能收到事件但 `message.content` 为空，表现为“没反应”。
- 代理环境：Discord REST 走 `fetch()`（undici `EnvHttpProxyAgent`），Discord Gateway 走 `ws`（`proxy-agent`）；优先用 `curl --noproxy '*' https://discord.com/api/v10/gateway` 判断是否必须配置代理。
