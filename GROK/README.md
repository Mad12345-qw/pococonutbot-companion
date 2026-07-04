# Feishu Grok Bridge

这个项目是一个独立的 Render Web Service，用来把飞书机器人消息转给 Grok，并把最终回答发回飞书。

核心处理：

- 飞书事件入口 `/feishu/events` 会立刻返回 200，避免飞书回调超时。
- 联网检索走后台任务，先可选发送“开始检索”，随后一定发送最终结果或失败原因。
- 稳定联网搜索优先使用 xAI Responses API 的 `web_search` 工具。
- Grok CLI 会在 Render 构建时安装，作为普通对话的可选 fallback。

## 为什么截图会卡在“正在检索”

本地 CLI 普通聊天能通，不代表 Render 后台联网搜索也稳定。联网搜索属于长工具调用，CLI 会先输出检索状态；如果进程、流式输出或平台超时没有等到最终文本，飞书就只看见“正在检索”而没有下文。

这个项目的修复方式是：

- 飞书回调与模型请求解耦。
- 长请求有服务端超时。
- 搜索优先使用 xAI API 的服务端 `web_search`，不把 CLI 的中间状态当最终答案。
- 任何失败都会发一条明确失败消息。

## Render 环境变量

必填：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=***
XAI_API_KEY=xai_***
```

可选：

```env
FEISHU_VERIFICATION_TOKEN=
FEISHU_ENCRYPT_KEY=
GROK_DEPLOYMENT_KEY=
GROK_AUTH_JSON_B64=
DEBUG_TOKEN=
```

注意：`rnd_...` 是 Render API key，只能管理 Render，不能调用 Grok。Render 上推荐配置 `XAI_API_KEY`；如果要复用本地 `grok login`，可以把本地 `auth.json` base64 后放到 `GROK_AUTH_JSON_B64`，服务启动时会还原到 `$HOME/.grok/auth.json`。不要把 `auth.json` 提交进 Git。

## 飞书回调地址

部署后在飞书开放平台事件订阅里配置：

```text
https://<render-service>.onrender.com/feishu/events
```

需要开启事件：

```text
im.message.receive_v1
```

## 本地检查

```powershell
npm install
npm run check
```
