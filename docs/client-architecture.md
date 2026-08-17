# 智能笔记系统 — 客户端架构设计（总览）

> 版本：v0.8（2026-08）重构 —— 功能实现拆分至 `docs/features/`，本文档只保留**架构摘要、跨功能协议与文档索引**；每个功能的完整实现细节见各自功能文档。
> 配套文档：
> - `docs/knowledge-rag.md` —— **RAG 知识库索引策略的说明文档**（检索/索引算法与 KN_* 配置全表，不属于功能实现文档）。
> - `docs/features/*.md` —— 每个功能单独一份实现文档。

## 0. 文档结构与阅读指南

```
docs/
├── client-architecture.md   ← 本文档：架构总览 + 协议 + 功能索引（精简）
├── knowledge-rag.md         ← RAG 知识库索引策略说明（独立保留）
└── features/                ← 功能实现文档（每个功能一份）
    ├── chat-pipeline.md     # AI 对话链路（SSE/流式/附件）
    ├── sidecar-manager.md   # sidecar 生命周期管理
    ├── context-engine.md    # 上下文工程（分级/压缩/拆卸）
    ├── long-term-memory.md  # 长期记忆（Mem0+qdrant）
    ├── knowledge-base.md    # 知识库管理与 AI 问答
    ├── file-library.md      # 文件库与富文本编辑器
    └── ai-doc-tools.md      # AI 文档工具（整理/翻译/总结/写作）
```

阅读建议：先读 §4 总体架构 → §7 功能总览（按需跳转功能文档）→ §8 协议。本文档 48KB→~12KB，只留摘要。

## 1. 实现状态总览

| 模块 | 状态 | 说明 |
|------|------|------|
| AI 对话链路（SSE 流式） | ✅ | 端到端可用，含停止/错误处理 |
| sidecar 生命周期管理 | ✅ | 起停/发现/看门狗防孤儿 |
| 上下文工程 | ✅ | N=8/M=16 分级保留、压缩、拆卸 |
| 长期记忆 | ✅ | Mem0 + qdrant 跨会话事实沉淀 |
| 知识库 RAG | ✅ | BM25+FAISS 混合召回（策略见 knowledge-rag.md） |
| 文件库与富文本编辑器 | ✅ | TipTap v3 `.html` 存储、公式/图片/对齐 |
| AI 文档工具 | ✅ | 写作/翻译/总结/图片 + 对话整理 @organize |
| 云端多端同步 | ⏳ | 规划中，见 §13 |

## 2. 文档范围

本文档面向：后续接手者快速建立"系统有哪些进程、怎么通信、功能怎么找"的心智模型。**不重复**功能实现细节（在 features/），**不重复** RAG 算法细节（在 knowledge-rag.md）。

## 3. 产品需求回顾

本地优先的智能笔记应用：以**富文本文档**为核心资产（`.html`），叠加本地 AI 能力（对话、文档整理、知识库问答、长期记忆），全程可离线使用，数据不出本机。

## 4. 总体架构（三进程 + 一向量库）

```
┌────────────────────────────────────────────┐
│ Electron Main 进程                          │
│  - 窗口管理 / 菜单                          │
│  - IPC（library:* / chat:* / knowledge:* …）│
│  - SidecarManager（起停/探测/看门狗）        │
│  - GatewayClient（SSE 转发 / Abort 停止）    │
└───────────┬────────────────────────────────┘
            │ HTTP (127.0.0.1, Bearer token, SSE)
┌───────────▼────────────────────────────────┐
│ Renderer（React 19）                        │
│  - 聊天页 / 文件库 / 编辑器 / 知识库管理     │
│  - TipTap 富文本 .html 存储（800ms 防抖）    │
└────────────────────────────────────────────┘
            │ 同一 sidecar 进程
┌───────────▼────────────────────────────────┐
│ Sidecar（Python Flask，本地 AI 服务）        │
│  - /chat SSE 对话 + 上下文引擎               │
│  - 知识库索引/检索 / 长期记忆 / 附件处理      │
└────────────────────────────────────────────┘
        ┌─────── 一向量库层 ───────┐
        │ qdrant（长期记忆）        │
        │ FAISS + 手写 BM25（知识库）│
        └──────────────────────────┘
```

数据流：Renderer 发消息 → Main IPC → Gateway → Sidecar `/chat` → SSE 流回。详见 [chat-pipeline.md](docs/features/chat-pipeline.md)。

## 5. 技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | Electron（contextIsolation:true, sandbox:true） |
| 前端 | React 19 + Vite（electron-vite）+ Tailwind v4 |
| 编辑器 | TipTap v3 + mathematics 扩展 + KaTeX（公式）、allowBase64（图片内嵌）、TextAlign |
| 渲染 | react-markdown + KaTeX（聊天回复，.na-md） |
| AI 服务 | Python + Flask（werkzeug `make_server` 随机端口） |
| 记忆/检索 | Mem0 + qdrant；FAISS + numpy + 手写 BM25/RRF/级联重排 |
| Markdown→HTML | unified + remark-parse/gfm/math + remark-rehype + rehype-stringify |

## 6. 目录结构

```
NA/
├── src/            # Renderer（App/组件/lib）
├── electron/       # Main 进程（main/、preload/）
│   └── main/       #   index.ts（IPC）、gateway/、library/、sidecar/
├── sidecar/        # Python AI 服务（app.py、registry.py、config.py、routes/、services/）
├── data/           # 运行时数据（gitignored，见 §9）
├── docs/           # 本文档 + features/ + knowledge-rag.md
└── Prompt/         # 系统提示（SystemPrompt.md，含 @organize 段）
```

## 7. 功能总览与文档索引

| 功能 | 摘要 | 实现文档 |
|------|------|----------|
| **AI 对话链路** | 用户消息 → SSE 流式回复；Gateway 转发 + Abort 停止；`meta/chunk/done/error` 命名事件协议；附件上传（≤100MB，白名单扩展名）。 | [features/chat-pipeline.md](docs/features/chat-pipeline.md) |
| **sidecar 生命周期** | Main 进程起停/发现（status.json）/看门狗防孤儿；`starting→ready→…` 状态机广播 renderer；`/healthz` 存活轮询。 | [features/sidecar-manager.md](docs/features/sidecar-manager.md) |
| **上下文工程** | T0/T1/T2/T3 分级保留（N=8/M=16）；中段摘要压缩、远端滚动摘要；T3 拆卸落盘可回载；接服务端只换 llm.py。 | [features/context-engine.md](docs/features/context-engine.md) |
| **长期记忆** | 跨会话事实抽取（Mem0 add/update/delete）→ qdrant 向量库；新会话检索 top-k 注入。 | [features/long-term-memory.md](docs/features/long-term-memory.md) |
| **知识库管理与 AI 问答** | 库的增删、文档上传建索引、状态展示；聊天「基于知识库」开关走 `/knowledge/query` 单次返回 answer+citations。 | [features/knowledge-base.md](docs/features/knowledge-base.md) |
| **文件库与富文本编辑器** | `data/library/` 下 `.html` 富文本；TipTap v3 编辑器（800ms 防抖保存、useEditorState、行内/块级公式、base64 图片、对齐）；`library:changed` 刷新。 | [features/file-library.md](docs/features/file-library.md) |
| **AI 文档工具** | 快捷写作/翻译/总结/图片；「整理文档」@organize：自绘三步浮层 → markdown→TipTap HTML 转换（`$`→inline-math、`$$`→block-math）→ 落盘 + 刷新。 | [features/ai-doc-tools.md](docs/features/ai-doc-tools.md) |

> **知识库 RAG 索引策略**（chunker、增量重建、BM25/FAISS 混合召回、RRF、级联重排、KN_* 配置、降级路径、自测）单独成文，见 [knowledge-rag.md](knowledge-rag.md)。

## 8. 客户端 ⇄ Sidecar 协议

- **寻址与鉴权**：仅绑定 `127.0.0.1`；随机 token 写入 `data/sidecar.status.json`，请求带 `Authorization: Bearer <token>`；**`GET /healthz` 免鉴权**（存活轮询用）。
- **SSE 会话协议**：`POST /chat` 返回 `text/event-stream`，命名事件 `meta/chunk/done/error`，`\n\n` 分块。事件表见 [chat-pipeline.md](docs/features/chat-pipeline.md) §4。
- **关键坑**：Flask 流式 generator 在请求上下文弹出后消费，内部访问 `current_app` 抛 `Working outside of application context` 并掩盖真异常 → 必须 `Response(stream_with_context(gen()), mimetype="text/event-stream")`。

### 8.1 端点全表

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/healthz` | 存活探测（免鉴权） |
| POST | `/chat` | AI 对话（SSE 流式） |
| GET | `/conversations` | 会话列表 |
| GET | `/conversations/<id>` | 会话历史轮次 |
| DELETE | `/conversations/<id>` | 删除会话 |
| POST | `/attachments` | 上传附件（multipart） |
| DELETE | `/attachments/<cid>/<id>` | 删除附件 |
| GET | `/memory/list` | 长期记忆列表 |
| DELETE | `/memory/<id>` | 删除记忆 |
| POST | `/memory/compact` | 记忆压缩 |
| GET | `/knowledge/status` | 索引引擎状态 |
| GET | `/knowledge/kbs` | 知识库列表 |
| POST | `/knowledge/kbs` | 新建知识库 |
| DELETE | `/knowledge/kbs/<id>` | 删除知识库 |
| GET | `/knowledge/kbs/<id>/files` | 库内已索引文件 |
| POST | `/knowledge/kbs/<id>/files` | 上传文档建索引 |
| DELETE | `/knowledge/kbs/<id>/files` | 删除文档索引 |
| POST | `/knowledge/reindex` | 全量重建索引 |
| POST | `/knowledge/search` | 检索（显式调用） |
| POST | `/knowledge/query` | 基于知识库 AI 问答（answer + citations） |

## 9. 数据存储

运行时数据全在 `data/`（gitignored）：

| 路径 | 内容 | 说明 |
|------|------|------|
| `data/library/` | 用户文档 | `.html` 富文本，任意多级目录 |
| `data/conversations/<cid>/` | 每对话轮次 | `turns.json`（含 tier 标记）、`context.jsonl`（拆卸产物）、`attachments/` |
| `data/memory/` | 长期记忆 | qdrant 向量 + 事实 JSON |
| `data/kb/` | 知识库索引 | 倒排 + 向量（KN_* 配置落盘） |
| `data/sidecar.status.json` | sidecar 身份 | `{host, port, token, pid}`，Main 据此发现 |

## 10. 离线降级

- **sidecar 未就绪**：聊天发送/知识库操作禁用，顶部状态条提示。
- **知识库无向量引擎**：检索降级为纯 BM25 关键词（numpy 兜底），见 knowledge-rag.md 降级路径。
- **无网络**：LLM 请求报错 → 气泡内 `[错误] …` 展示，不丢会话数据。

## 11. 安全基线

- Sidecar 仅绑定回环 + 每次启动随机 token；renderer 全部 IPC 走 preload 白名单，`contextIsolation:true, sandbox:true`。
- 本地文档/记忆/知识库数据不对外提供任何服务；仅 `/healthz` 免鉴权且不含业务数据。

## 12. 开发与验证

- 开发工作流：`npm run dev`（electron-vite）+ sidecar；`data/` 为运行时数据不提交。
- 验证手段：CDP 驱动真实 Electron 窗口做 E2E 冒烟（渲染+交互+落盘全链路）；SSE/端点行为用 curl 直测 sidecar（Git Bash curl 中文 body 用文件传）。
- Markdown→TipTap 转换有独立最小复现脚本（temp/）验证公式边界。

## 13. 云端预留

规划中：多端同步（文档/知识库/会话上云）、云端 LLM 网关（现状为本地直连 deepseek/qwen）。接入约束：上下文引擎与 LLM 解耦于 `llm.py`，便于切云端网关。

## 14. 待后续确认

- 多端同步的冲突策略与加密方案。
- 用户档案级长期记忆（当前为对话级）。
- 知识库文档的增量同步（当前为手动上传）。
