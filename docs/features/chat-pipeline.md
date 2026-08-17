# AI 对话链路（Chat Pipeline）

> 模块：Renderer `src/lib/use-chat.ts`、Main `electron/main/gateway/`、Sidecar `sidecar/routes/chat.py`、`sidecar/app.py`。
> 本文档描述"用户发一条消息 → 收到流式回复"的完整链路：端到端时序、SSE 事件协议、IPC 通道、UI 聊天接入与附件上传。
> 状态：✅ 已实现。

## 1. 端到端时序

```
Renderer (React)                    Main (Electron)                     Sidecar (Flask)
─────────────────                  ────────────────                     ───────────────
useChat.send(text) ──window.api.chat.send──▶ ipcMain 'chat:send'
                                             │  GatewayClient.sendChat
                                             │    POST /chat (Bearer token)
                                             │  ────────────────────────────▶ /chat
                                             │                             prepare_turn(user_text)
                                             │                                  │ 拆卸用户输入
                                             │                                  │ 组装消息链（系统+锚点+压缩+近期）
                                             │    ◀── SSE meta ────────────────┘
                                             │    ◀── SSE chunk ── LLM 流式
  chat:event {chunk} ◀── webContents.send ──┘
  逐字追加到最后一条 assistant 气泡
                                             │    ◀── SSE done（含 tier_counts/路径）
  chat:event {done} ◀── webContents.send ────┘
  收起流式态
```

## 2. Gateway（SSE 转发，Main 进程）✅

文件：`electron/main/gateway/{client.ts,sse.ts}`。

- `GatewayClient`：从 SidecarManager 取 endpoint，`POST /chat`（Bearer 鉴权），流式读取响应体并按 `\n\n` 切分 SSE 事件，逐条 `onEvent` 回调；`AbortController` 支持 `chat:stop` 中途停止。
- `parseSseBlock`（sse.ts）：解析 `event: X\ndata: {json}` 块，纯函数、无运行时依赖，可被 Node 直接加载测试。
- IPC 通道：
  - `ipcMain.handle('chat:send', ...)` → 校验 → gateway 拉流 → `chat:event` 转发回请求窗口；`AbortError` 静默（前端自行收流式态）。
  - `ipcMain.handle('chat:stop', ...)` → `gateway.abort(conversationId)`。
  - preload 暴露 `window.api.chat.{send,stop,onEvent}`。

## 3. Sidecar Flask 接入 ✅

- `sidecar/app.py`：`create_app()` + auth 中间件（`Authorization: Bearer <token>`，**`/healthz` 免鉴权**便于存活轮询）；`run_server()` 用 werkzeug `make_server` 绑定随机高位端口，并把 `{host, port, token, pid}` 写入 `data/sidecar.status.json`。
- `sidecar/registry.py`：对话注册表（内存 `conversation_id → ContextManager`），重启后按 conversation_id 从磁盘恢复。
- `POST /chat` 处理：
  1. 校验 conversation_id / message / depth（缺省 conversation_id 时新建并回传）。
  2. `prepare_turn`（拆卸用户输入 + 组装消息链，见 [context-engine.md](context-engine.md)）。
  3. LLM 流式 → 逐块发 SSE `chunk`。
  4. 流式完成 → `finalize_turn`（拆卸回复/工具 → 重算分级 → 落盘，见 [context-engine.md](context-engine.md)）。
  5. `done` 事件携带完整 `reply` 与分级统计。

**应用内命令**：`@organize <路径>` 开头视为"将对话整理为文档"命令（走 `finalize_organize_turn` 专用收尾，不做拆卸/记忆沉降；完整链路见 [ai-doc-tools.md](ai-doc-tools.md)）。

## 4. SSE 事件协议（/chat）

请求体：`{"conversation_id": "...", "message": "...", "provider": "deepseek|qwen", "depth": "fast|standard|deep", "attachment_ids": [...]}`。响应 `text/event-stream`，**命名事件**，每条 `event: <type>\ndata: <json>\n\n`（空行分隔）：

| 事件 | data | 说明 |
|------|------|------|
| `meta` | `{conversation_id, n, m, depth}` | 会话建立，含当前分级阈值与深度回显 |
| `chunk` | `{content}` | 流式增量（逐字） |
| `done` | `{conversation_id, reply, tier_counts, context_path, dismantled_path}` | 收尾，完整 reply + 分级结果 + 落盘路径 |
| `error` | `{error}` | 出错（本轮不回写） |

**已知坑（Flask 流式生成器与请求上下文）**：视图返回的流式 generator 在**请求上下文弹出后才被消费**，generator 内访问 `current_app`（如 `except` 里的 `logger.exception`）会抛 `RuntimeError: Working outside of application context`，**掩盖真异常**并导致连接中途断开（gateway 侧表现为 undici `terminated`）。修法：

```python
resp = Response(stream_with_context(generate()), mimetype="text/event-stream")
```

## 5. UI 聊天接入 ✅

- `src/lib/use-chat.ts`：单对话状态 —— conversationId 首发时 `crypto.randomUUID()` 生成并贯穿会话；订阅 `sidecar:status`（就绪前禁用发送）；订阅 `chat:event` 把 chunk 逐字追加到最后一条 assistant 消息；`stop()` 本地收流式态 + 通知主进程 abort。对话轮次按 `kind` 分级（默认 `chat`；知识库问答 `kb`、对话整理 `organize` 不进入上下文分级）。
- `chat-page.tsx`：无消息 → 空态（居中 Logo + 输入框）；有消息 → 消息流 + 底部输入框。
- `chat-thread.tsx`：用户右侧绿色气泡、assistant 左侧白底气泡（内容用 react-markdown + KaTeX 渲染，`.na-md`）；流式时末尾显示脉冲光标；新消息自动滚到底。
- `chat-input.tsx`：多行输入、回车发送（避开中文输入法组词）、模型选择、快捷能力按钮（写作/翻译/总结/图片，见 [ai-doc-tools.md](ai-doc-tools.md)）、「基于知识库」开关（见 [knowledge-base.md](knowledge-base.md)）、「整理文档」按钮（见 [ai-doc-tools.md](ai-doc-tools.md)）；流式时发送键变**停止键**。

## 6. 附件上传

- 白名单扩展名：`pdf / docx / xlsx / txt / md / html / png / jpg / jpeg`，体积上限 **100MB**。
- 上传：`POST /attachments`（multipart）→ sidecar 落盘到 `data/conversations/<cid>/attachments/<id><ext>` + `attachments.json` 元数据。
- 注入上下文：`attachment_ids` 随消息发送，sidecar 读文件内容拼入上下文（txt/md/html 直读；pdf/docx/xlsx 提取文本；图片 ≤ 阈值内联 base64，超限走引用说明）；带图消息默认 `provider=qwen`。
- 删除：`DELETE /attachments/<cid>/<id>`（文件 + 元数据）。
- 每消息语义：附件随消息发出后清空输入区附件芯片。

## 7. 关联文档

- sidecar 起停/发现/看门狗：见 [sidecar-manager.md](sidecar-manager.md)。
- 上下文组装/分级保留：见 [context-engine.md](context-engine.md)。
- 客户端 ⇄ Sidecar 全量端点表：见 `docs/client-architecture.md` §9。
