# 智能笔记系统 — 客户端架构设计与技术文档

> 版本：v0.6（AI 对话链路 + 上下文工程 + DS 深度模式 + 附件上传 + 长期记忆落地）
> 最后更新：2026-08-11
> 变更：v0.5 基础上，实现「AI 对话长期记忆」（Mem0 + 本地 qdrant 向量 + bge-small-zh 嵌入 + bge-reranker 精排 + 每轮异步抽取 + 检索注入上下文），并新增 `/memory/*` 端点；
> 各模块以「✅ 已实现 / 🧭 规划中」标注，规划内容仍为既定方向。

---

## 0. 实现状态总览

| 模块 | 状态 | 说明 |
|------|------|------|
| 上下文引擎（缩减+拆卸+分级保留） | ✅ 已实现 | sidecar 内自研，见 §7 |
| Flask sidecar 服务与 SSE 协议 | ✅ 已实现 | `/healthz` `/chat`，见 §6.4 / §8 |
| Electron SidecarManager | ✅ 已实现 | 起停/发现/看门狗防孤儿/状态广播，见 §6.2 |
| Gateway（SSE 转发） | ✅ 已实现 | main 进程 HTTP 客户端，见 §6.3 |
| 聊天 UI（空态/消息流/流式/停止） | ✅ 已实现 | 见 §6.6 |
| DS 深度模式（推理强度） | ✅ 已实现 | 快速/标准/深度 → reasoning_effort，API 不支持退化为 temperature，见 §7.6 |
| 文件上传[+]（附件，仅保存展示） | ✅ 已实现 | PDF/DOCX/XLSX/TXT/MD/HTML/PNG/JPG，≤100MB，见 §8.1 / §9.1 |
| 客户端 SQLite（笔记/笔记本） | 🧭 规划中 | 见 §10 |
| 长期记忆（Mem0 + 本地 qdrant） | ✅ 已实现 | 抽取/存储/检索/注入全链路，见 §7.9 |
| 知识库 / 文档解析 | 🧭 规划中 | 见 §10 |
| 整理/美化能力 | 🧭 规划中 | 见 §10 |

---

## 1. 文档范围

本文档定义「智能笔记系统」客户端 + 本地 AI 服务的整体架构。云端同步暂缓，仅预留接口。

部署形态（已确认）：**本地优先** —— Flask 服务以 sidecar 方式跑在用户本机，Electron 客户端启动时拉起；LLM 走**在线 API**（未来换服务端大模型只改 `llm.py`），嵌入/精排/长期记忆向量库均为**本地**（sentence-transformers + qdrant on-disk，离线可用），断网时对话降级、笔记编辑不受影响。

---

## 2. 产品需求回顾（已确认）

| 项 | 决策 |
|----|------|
| 平台 | Windows 桌面应用 |
| 笔记本 | 平级，不支持嵌套 |
| 笔记 | 富文本；图片可折叠为极小占位链接 |
| AI 助手 | 编辑区右侧可折叠面板；上下文边界 = 当前笔记所在的**笔记本** |
| 知识库 | 精选笔记的集合 + 用户上传的外部文档 |
| 长期记忆 | AI 跨会话记住笔记本相关的要点/偏好（Mem0 + 本地 qdrant 向量存储） |
| 离线 | 客户端离线可用；在线 API 不可达时 AI 降级 |
| 外部文档 | 默认 PDF / Word / TXT / Markdown，Python 侧解析 |
| 知识库内文档是否参与 AI | 否，AI 严格只看文件夹 |

---

## 3. 总体架构（三进程 + 一向量库）

```
┌────────────────────────────────────────────────────────────────┐
│  用户本机                                                        │
│                                                                  │
│  ┌──────────────────────────── Electron ────────────────────┐  │
│  │  Renderer (React)   ⇄   Preload (contextBridge)   ⇄  Main │  │
│  │  侧栏/编辑器/AI面板/知识库       window.api              │  │
│  │                                                        │   │
│  │  Main 进程：窗口管理 / 客户端 SQLite(规划) /             │   │
│  │            SidecarManager(✅) / Gateway(✅)              │   │
│  └───────────────────────────┬──────────────────────────────┘  │
│                              │ HTTP(127.0.0.1) + SSE           │
│                              ▼                                │
│  ┌──────────────────── Python Sidecar ─────────────────────┐  │
│  │  Flask (REST + SSE 流式)          ✅ 已实现              │   │
│  │  上下文引擎(缩减/拆卸/分级保留)     ✅ 已实现              │   │
│  │  长期记忆(Mem0 + qdrant + 本地嵌入/精排) ✅ 已实现         │   │
│  │  LangChain 编排 · 知识库 · 文档解析  🧭 规划中            │   │
│  │  └── qdrant 本地 on-disk 向量库（长期记忆） ✅ 已实现      │   │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

要点：
- **Electron 客户端**：纯 UI + 笔记/笔记本本地存储，不直接调外部 AI。
- **Python Sidecar**：所有 AI / 向量 / 文档解析能力。Electron 启动时拉起，退出时回收。
- **qdrant 本地 on-disk**：嵌入 sidecar 进程内，无需独立部署，当前承载长期记忆（§7.9）；知识库规划复用同一套向量设施。
- 客户端 ⇄ sidecar 仅经 **127.0.0.1 本地 HTTP**，不暴露公网。

---

## 4. 技术栈

### 4.1 客户端（Electron）— ✅ 已实现

| 层 | 选型 | 说明 |
|----|------|------|
| 框架 | Electron + React + TypeScript | Windows 桌面 |
| 构建 | electron-vite (Vite) | 主/预加载/渲染统一构建 |
| UI | Tailwind CSS v4 + lucide-react | 原子样式 + 图标 |
| IPC | contextBridge + ipcRenderer/Main | 上下文隔离 + sandbox |

> 富文本编辑器（TipTap）、状态管理（Zustand）、SQLite（better-sqlite3）为 🧭 规划项。

### 4.2 Python Sidecar

| 层 | 选型 | 状态 | 说明 |
|----|------|------|------|
| Web 框架 | Flask | ✅ | REST + SSE 流式对话 |
| LLM 客户端 | requests（OpenAI 兼容，自研） | ✅ | 见 §7.6；接服务端大模型只换这一层 |
| 上下文引擎 | 自研（非 LangChain） | ✅ | 缩减/拆卸/分级保留，见 §7 |
| 长期记忆 | mem0ai + qdrant-client + sentence-transformers | ✅ | 抽取/存储/检索/注入，见 §7.9 |
| 嵌入 / 精排 | BAAI/bge-small-zh-v1.5（512 维）+ BAAI/bge-reranker-base | ✅ | 本地离线，HF_HOME 指向 data/memory/models |
| AI 编排 | LangChain | 🧭 | 对话、工具、记忆链编排（后续可引入） |
| 向量库 | qdrant 本地 on-disk（经 mem0 封装） | ✅ | 长期记忆已落地；知识库复用同设施 |
| 文档解析 | pdfplumber / python-docx / markdown | 🧭 | PDF / Word / MD / TXT |
| 打包 | PyInstaller（后续） | 🧭 | sidecar 打包为独立可执行文件 |

---

## 5. 目录结构（当前实际）

```
na/
├─ electron/                     # Electron 客户端
│  ├─ main/
│  │  ├─ index.ts                # 入口、窗口管理、IPC 注册（chat:send/stop）
│  │  ├─ sidecar/                # ✅ SidecarManager
│  │  │  ├─ manager.ts           # 进程拉起/状态文件发现/healthz/崩溃重启/看门狗
│  │  │  └─ config.ts            # python 路径、args、状态文件、超时
│  │  └─ gateway/                # ✅ sidecar HTTP 客户端（SSE 转发）
│  │     ├─ client.ts            # GatewayClient：fetch + 流式读取 + AbortController
│  │     └─ sse.ts               # parseSseBlock（纯函数，可单测）
│  └─ preload/index.ts           # window.api（sidecar / chat 两组）
├─ src/                          # React 渲染层
│  ├─ App.tsx                    # 导航 + 主内容区
│  ├─ lib/
│  │  ├─ use-chat.ts             # ✅ 聊天状态 hook（消息/流式/停止/sidecar 状态）
│  │  └─ cn.ts                   # classnames 合并
│  └─ components/
│     ├─ sidebar/                # 左侧边栏（导航 + 笔记本占位）
│     └─ na/                     # NA 对话页
│        ├─ chat-page.tsx        # 空态 ↔ 对话态切换
│        ├─ chat-input.tsx       # 输入框 + 快捷能力（发送/停止）
│        ├─ chat-thread.tsx      # 消息流（气泡 + 流式光标）
│        ├─ ds-dropdown.tsx      # DS 深度切换下拉（占位）
│        ├─ logo.tsx             # 可交互 Logo
│        └─ recent-conversations.tsx  # 右侧最近对话面板（占位）
├─ sidecar/                      # ✅ Python AI 服务
│  ├─ app.py                     # Flask 入口、auth 中间件、父进程看门狗、MemoryService 起停
│  ├─ config.py                  # ServerConfig（host/port/token/status file）
│  ├─ registry.py                # 对话注册表（内存 + 磁盘恢复，注入 memory_provider）
│  ├─ routes/                    # health.py / chat.py（SSE）/ attachments.py（上传）/ memory.py
│  ├─ scripts/self_test.py       # 上下文引擎自测（真实 API / --dry-run）
│  ├─ scripts/self_test_memory.py# 长期记忆自测（store 增/查/并/删 + 抽取 + 融合）
│  ├─ services/context/          # ✅ 上下文工程（见 §7）
│  │  └─ prompts/extract_memories.md  # 长期记忆抽取提示词（复用 render()）
│  └─ services/memory/           # ✅ 长期记忆（见 §7.9）
│     ├─ config.py               # MemoryConfig（模型/权重/路径，读 env）
│     ├─ types.py                # MemoryDraft / MemoryHit
│     ├─ store.py                # Mem0 封装：惰性初始化、去重合并、安全降级
│     ├─ extraction.py           # 从拆卸内容结构化抽取候选记忆（复用 llm.py）
│     ├─ retrieval.py            # 混合召回→精排归一→业务融合→top-k
│     └─ service.py              # 异步沉降 worker + 注入回调 + 只读降级
│     ├─ config.py               # SidecarConfig（N/M、long_text、.env 加载）
│     ├─ context_manager.py      # 编排核心：准备/收尾一轮、分级重算、组装消息链
│     ├─ dismantler.py           # 拆卸（用户/回复/工具）
│     ├─ reducer.py              # 缩减（用户长文本/回复/锚点提取）
│     ├─ thresholds.py           # N/M 动态调整公式
│     ├─ storage.py              # 逐对话 JSON 落盘
│     ├─ types.py                # Turn / Dismantled / Reduced 数据结构
│     ├─ llm.py                  # LLMClient / DeepSeekClient / FakeLLMClient
│     ├─ prompts.py              # 提示词加载与渲染
│     └─ prompts/*.md            # 各操作提示词（见 §7.7）
├─ Prompt/SystemPrompt.md        # 主系统提示词
├─ temp/.env                     # 测试 API key（勿提交，后续换服务端）
├─ data/                         # 运行数据（gitignored）
│  ├─ sidecar.status.json        # 实际端口 + token + pid（发现用）
│  ├─ threshold_stats.json       # 对话轮数统计（N/M 动态调整）
│  ├─ conversations/<id>/        # 每对话 context.json + dismantled.json + attachments/
│  └─ memory/                    # ✅ 长期记忆（见 §9.2）
│     ├─ qdrant/                 # qdrant on-disk 向量库
│     ├─ history.db              # mem0 事件历史 SQLite
│     ├─ errors.jsonl            # 抽取失败记录（/memory/compact 重跑）
│     └─ models/                 # HF 模型缓存（bge-small-zh / bge-reranker-base）
└─ docs/client-architecture.md   # 本文档
```

---

## 6. 已实现：AI 对话链路

### 6.1 端到端流程（时序）

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

### 6.2 SidecarManager（Electron 主进程）✅

文件：`electron/main/sidecar/{manager.ts,config.ts}`。职责是「起停哨兵 + 接线员」：

1. **spawn**：`python -m sidecar.app --port 0`（cwd=仓库根），spawn 时注入 `PYTHONIOENCODING=utf-8`（修 Windows GBK 日志乱码）。
2. **发现**：spawn 前删除过期状态文件；轮询 `data/sidecar.status.json` 直到 **pid 匹配本次子进程**（防读残留）→ 读出实际端口 + token。
3. **健康**：轮询 `GET /healthz`（免鉴权）通过 → `ready`。
4. **凭证**：持有 `{baseUrl, token}`，供 Gateway 发起带鉴权请求。
5. **回收**：`before-quit` 优雅 `stop()`（kill + 等退出）；`process.on('exit')` 同步 `killSync()` 兜底。
6. **崩溃重启**：非主动退出 → 按指数退避重启（1s→30s 封顶）；spawn 本身失败（python 找不到）不重启。
7. **看门狗防孤儿**：spawn 时注入 `NA_SIDECAR_PARENT_PID`，sidecar 内起 daemon 线程每 2s 查父进程存活（Windows 用 ctypes，无 psutil），父死即 `os._exit(0)`。解决了「Ctrl+C / taskkill /F 硬杀时 JS 清理不执行」以及「taskkill /T 因子进程在跑拒绝优雅关父进程」两个 Windows 下的孤儿场景。
8. **广播**：`emit('status')` → 主进程 `webContents.send('sidecar:status')` → preload `window.api.sidecar.onStatusChange`。

### 6.3 Gateway（SSE 转发）✅

文件：`electron/main/gateway/{client.ts,sse.ts}`。

- `GatewayClient`：从 SidecarManager 取 endpoint，`POST /chat`（Bearer 鉴权），流式读取响应体并按 `\n\n` 切分 SSE 事件，逐条 `onEvent` 回调；`AbortController` 支持 `chat:stop` 中途停止。
- `parseSseBlock`（sse.ts）：解析 `event: X\ndata: {json}` 块，纯函数、无运行时依赖，可被 Node 直接加载测试。
- IPC 通道：
  - `ipcMain.handle('chat:send', ...)` → 校验 → gateway 拉流 → `chat:event` 转发回请求窗口；`AbortError` 静默（前端自行收流式态）。
  - `ipcMain.handle('chat:stop', ...)` → `gateway.abort(conversationId)`。
  - preload 暴露 `window.api.chat.{send,stop,onEvent}`。

### 6.4 Sidecar Flask 服务 ✅

- `sidecar/app.py`：`create_app()` + auth 中间件（`Authorization: Bearer <token>`，**`/healthz` 免鉴权**便于存活轮询）；`run_server()` 用 werkzeug `make_server` 绑定随机高位端口，并把 `{host, port, token, pid}` 写入 `data/sidecar.status.json`。
- `sidecar/registry.py`：对话注册表（内存 `conversation_id → ContextManager`），重启后按 conversation_id 从磁盘恢复。
- 路由：
  - `GET /healthz` — 存活/就绪。
  - `POST /chat` — SSE 流式对话（见 §8.2）。

### 6.5 上下文引擎 ✅

策略与实现细节见独立章节 **§7 上下文工程**。本节仅列对话链路接入点：`POST /chat` 内先 `prepare_turn`（拆卸用户输入 + 组装消息链），流式完成后 `finalize_turn`（拆卸回复/工具 → 重算分级 → 落盘），编排时序见 §7.4。

### 6.6 UI 聊天接入 ✅

- `src/lib/use-chat.ts`：单对话状态 —— conversationId 首发时 `crypto.randomUUID()` 生成并贯穿会话；订阅 `sidecar:status`（就绪前禁用发送）；订阅 `chat:event` 把 chunk 逐字追加到最后一条 assistant 消息；`stop()` 本地收流式态 + 通知主进程 abort。
- `chat-page.tsx`：无消息 → 空态（居中 Logo + 输入框）；有消息 → 消息流 + 底部输入框。
- `chat-thread.tsx`：用户右侧绿色气泡、assistant 左侧白底气泡；流式时末尾显示脉冲光标；新消息自动滚到底。
- `chat-input.tsx`：多行输入、回车发送（避开中文输入法组词）、快捷能力按钮（占位）；流式时发送键变**停止键**。

---

## 7. 上下文工程（Context Engineering）

> 上下文引擎是 sidecar 内自研的核心模块（非 LangChain），代码全部位于 `sidecar/services/context/`。策略 = **上下文缩减（reduction）+ 上下文拆卸（dismantling）+ 分级保留（tiered retention）**。客户端不感知其内部，只经 §8 的 `/chat` 协议消费。

### 7.1 总览：双产物模型与模块职责

一次对话的每一轮，上下文引擎产出**两套并行产物**：

| 产物 | 去向 | 作用 |
|------|------|------|
| **缩减 reduced** | 组装进后续轮次的 LLM 消息链 | 控制上下文体积、保留关键信息 |
| **拆卸 dismantled** | 落盘到每对话 `dismantled.json` | 结构化留存全部轮次细节，供长期记忆/检索使用 |

模块职责（`sidecar/services/context/`）：

| 文件 | 职责 |
|------|------|
| `config.py` | `SidecarConfig`：N/M、长文本阈值、`.env` 加载 |
| `context_manager.py` | 编排核心：准备/收尾一轮、分级重算、组装消息链 |
| `dismantler.py` | 拆卸（用户/回复/工具调用） |
| `reducer.py` | 缩减（用户长文本/回复/锚点提取）+ 工具上下文渲染 |
| `thresholds.py` | N/M 动态调整公式 |
| `storage.py` | 逐对话 JSON 落盘（原子写） |
| `types.py` | `Turn` / `*Dismantled` / `*Reduced` 数据结构 |
| `llm.py` | `LLMClient` 接口 + DeepSeek/Fake 实现 |
| `prompts.py` + `prompts/*.md` | 操作提示词加载与渲染 |

### 7.2 分级保留与动态阈值

| 层级 | 范围 | 保留内容 | 丢弃 |
|------|------|----------|------|
| `recent`（近期） | 距最新 0~N 轮 | 全量原文 | — |
| `compressed`（中期） | N~M 轮 | 用户意图摘要 + 关键结论 + 约束 + 工具(参数+结果) | 中间推理过程 |
| `anchored`（远期） | M+ 轮 | 仅事实锚点（用户偏好、已确认事实） | 其余全部 |

- 初始 N=8、M=16（env `CTX_N`/`CTX_M` 可覆盖）。
- **N/M 动态调整**（`thresholds.py`）：对话结束时记录轮数（`data/threshold_stats.json`），样本 ≥3 段时按平均轮数重算：
  ```
  N = clamp(round(avg*0.4), 4, 12)
  M = clamp(round(avg*0.8), N+4, 24)
  ```
- **惰性转换**：压缩在轮次移出近期窗时才触发，锚点提取在移出中期窗时才触发，避免每轮无谓 LLM 调用；层级只升不降。

### 7.3 缩减 vs 拆卸（对象级策略）

| 对象 | 缩减（进上下文） | 拆卸（落盘 dismantled.json） |
|------|------------------|------------------------------|
| 用户输入 | 尽量保留原文；>800 字符（`CTX_LONG_CHARS`）触发意图提取 + 关键片段 | 约束条件（保留）+ 用户意图（拆卸） |
| 模型回复 | 仅保留结论 + 关键论据，丢弃推理链 | 结论（保留）+ 支撑（拆卸） |
| 工具调用 | 参数 + 返回结果摘要（其余丢弃） | 三层：调用意图 / 调用参数 / 结果摘要（保留后两者，意图拆卸） |

> 工具调用的缩减是拆卸三层的子集：一次 LLM 调用产出两者，避免重复调用。

### 7.4 编排时序（context_manager.py）

每一轮（一次用户输入 → 一次流式回复）的完整时序：

```
prepare_turn(message)                          # 进入一轮
  1. 拆卸用户输入 → user_dismantled{constraints, intent}   （dismantler.user_input）
  2. 组装消息链（§7.4.1）→ messages（含本轮输入）
  3. 返回 (messages, user_dismantled)

[ /chat 流式返回 LLM chunks ]                  # routes/chat.py
  4. 拼装完整 reply

finalize_turn(message, reply, user_dismantled) # 收尾一轮
  5. 拆卸回复 → assistant_dismantled{conclusion, support}   （dismantler.assistant_reply）
  6. 若本轮有工具调用 → tool_calls[]（dismantler.tool_call，三层拆卸）
  7. 构造 Turn（§7.5）：
     - user_intent_summary 复用 user_dismantled.intent（不重复调 LLM）
     - user_key_fragments / constraints / key_conclusions 按层级填充
  8. 重算分级 _recompute_tiers（§7.2）：离最近轮次距离 > M → anchored；> N → compressed；否则 recent；只升不降
  9. 惰性触发：
     - 移出近期窗的轮次 → _compress（压缩为意图摘要+关键结论；
       用户输入仅当 >800 字符 CTX_LONG_CHARS 才调 reduce_user，否则保留原文）
     - 移出中期窗的轮次 → _anchor（extract_anchors 抽事实锚点）
  10. 落盘：context.json（分级运行态）+ dismantled.json（全部拆卸内容，§7.8）
```

#### 7.4.1 组装顺序（assemble_messages）

```
system(主系统提示词 Prompt/SystemPrompt.md)
→ system(远期事实锚点合并块)   ← 若存在（anchored 层）
→ system(长期记忆块)           ← 若 memory_provider 命中（§7.9.4，跨会话要点）
→ 中期轮 compressed（意图摘要 / 约束 / 关键结论 / 工具参数+结果）
→ 近期轮 recent（全量原文 + 工具缩减块 render_tool_for_context）
→ user(本轮输入)
```

> 长期记忆块格式：`system("长期记忆（跨会话已确认要点）：\n- [类别·重要N] 内容（来源 conv-xxx · 日期）")`，仅当记忆检索命中时出现；检索失败/未启用时该块不出现，`/chat` 行为与 v0.5 完全一致。

### 7.5 数据结构（types.py）

`Turn` 按层级保留的字段：

| 字段 | recent | compressed | anchored | 来源 |
|------|--------|-----------|----------|------|
| `user_text` | ✅ 原文 | ✂ 意图摘要+关键片段 | ✂ 仅锚点 | — |
| `user_intent_summary` | ✅ | ✅ | ✂ | 复用拆卸产物 intent |
| `user_key_fragments` | — | ✅ | ✂ | reduce_user |
| `constraints` | — | ✅ | ✂ | 拆卸产物 constraints |
| `key_conclusions` | — | ✅ | ✂ | reduce_assistant |
| `fact_anchors` | — | — | ✅ | extract_anchors |
| `tool_reduced` | ✅ | ✅ | ✂ | 工具参数+结果摘要 |

拆卸 / 缩减结构：

```
UserDismantled{constraints, intent}
AssistantDismantled{conclusion, support}
ToolCallDismantled{name, args, call_intent, result_summary}
ToolReduced{name, args, result_summary}      # = 拆卸三层去掉 call_intent 的子集
```

### 7.6 LLM 客户端（llm.py）

- `LLMClient` 接口：`chat` / `chat_json` / `stream_chat`；`chat_json` 内部对 `chat(json_mode=True)` 的输出做 `parse_json_like` 容错解析。
- `DeepSeekClient`：OpenAI 兼容，`requests` 直连 `${BASE_URL}/chat/completions`；JSON 模式发 `response_format={"type":"json_object"}`；流式解析 `data:` 行直到 `[DONE]`。key/模型读 `temp/.env`（`API_KEY`/`BASE_URL`/`MODEL`），**不写死**。
- **DS 深度模式**：`stream_chat(..., depth=...)` 把 快速/标准/深度 映射为 `reasoning_effort`（low/medium/high）+ 对应 temperature（0.7/0.4/0.1）；API 对未知字段返回 400 时**首次自动退化**为仅 temperature 并缓存，后续调用不再发送该字段。
- `FakeLLMClient`：离线自测（`--dry-run`）不触发网络；守护条件 `json_mode 或提示词含「只输出 JSON」`，然后按提示词**前 300 字符指令区的互斥短语**匹配分支返回固定 JSON。分支（互斥短语）：拆卸用户「拆成两部分：约束条件」/ 拆卸回复「拆成两部分：结论 与 支撑」/ 拆卸工具「拆成三层」/ 缩减用户「关键片段」/ 缩减回复「丢弃中间推理」/ 锚点「事实锚点」/ 长期记忆「跨会话长期保留」。⚠️ **修改操作提示词的指令措辞时须同步更新 FakeLLM 的分支短语，否则 dry-run 自测失真。**
- `parse_json_like`：容忍 markdown 围栏、前后杂讯，截取首个 `{` 到末个 `}` 后 `json.loads`；失败抛 `LLMError`。
- **可替换性**：接服务端大模型时，仅实现同一 `LLMClient` 接口替换 `llm.py`，缩减/拆卸/编排/存储上层全部不动。

### 7.7 操作提示词（prompts/）

`prompts.py` 负责加载与渲染：模板占位符用 `{{name}}`，`fill()` 做纯文本替换（避免 f-string 大括号冲突）；`load_prompt` 带内存缓存。操作类提示词以**单条 system 消息**发送（输出格式已内嵌在提示词里），不使用对话模板。

| 文件 | 操作 | 输入占位符 | 输出 JSON | 截断 |
|------|------|-----------|-----------|------|
| `dismantle_user.md` | 拆卸用户输入 | `{{text}}` | `{constraints, intent}` | — |
| `dismantle_assistant.md` | 拆卸模型回复 | `{{text}}` | `{conclusion, support}` | — |
| `dismantle_tool.md` | 拆卸工具调用 | `{{tool_name}} {{args}} {{result}}` | `{call_intent, args, result_summary}` | result 前 2000 字符 |
| `reduce_user.md` | 缩减长文本用户输入 | `{{text}}` | `{intent, key_fragments[]}` | text 前 4000 字符 |
| `reduce_assistant.md` | 缩减模型回复 | `{{text}}` | `{conclusion, key_arguments[]}` | text 前 4000 字符 |
| `extract_anchors.md` | 远期事实锚点提取 | `{{text}}` | `{anchors[]}` | text 前 4000 字符 |
| `extract_memories.md` | 长期记忆抽取（§7.9.2） | `{{text}}` | `{memories:[{text,category,importance}]}` | text 前 4000 字符 |

设计要点：
- 所有提示词强制「只输出 JSON，不要输出其他任何内容」，靠 `response_format` + `parse_json_like` 双保险。
- **拆卸不设文本长度截断**（要求保留全部约束/支撑信息）；**缩减有 4000 字符截断**，因为目标是压缩进上下文。
- 工具拆卸要求 `args` **原样保留**（LLM 不得改写），保证调用可回放。
- 每个文件首句固定「你负责对…做上下文…拆成…」，是 FakeLLM 分支匹配与 dry-run 一致性的锚点（见 §7.6）。
- 主系统提示词独立在仓库根 `Prompt/SystemPrompt.md`，每次组装消息链时作为 `system` 首条加载（§7.4.1）。

### 7.8 落盘（storage.py）

每对话一个目录 `data/conversations/<conversation_id>/`（gitignored）。写入用原子写：先写 `*.tmp` 再 `os.replace`，避免半写损坏。

| 文件 | 内容 | 用途 |
|------|------|------|
| `context.json` | `{conversation_id, n, m, updated_at, turns[]}`（每轮含 `seq/tier` 及按层级保留字段） | 分级保留运行态，重启恢复续对话 |
| `dismantled.json` | 按 `turns[seq]` 组织全部拆卸内容：`user{constraints,intent}` / `assistant{conclusion,support}` / `tool_calls[{name,args,call_intent,result_summary}]` | 即需求「拆卸内容一个 JSON 分对话保存」 |
| `data/threshold_stats.json` | 各对话完成轮数 | N/M 动态调整依据（§7.2） |

对话恢复：`registry.py` 首次访问某 conversation_id 且磁盘已有 `context.json` → `ContextManager.load_conversation` 从 JSON 还原分级状态与组装上下文（续对话），内存缓存按 id 复用。

### 7.9 长期记忆（Mem0 + 本地向量）✅ 已实现

代码全部位于 `sidecar/services/memory/`。基于 **Mem0（包名 `mem0ai`，version v1.1）**，向量库为**本地 qdrant on-disk**，嵌入用 `BAAI/bge-small-zh-v1.5`（512 维），精排用 `BAAI/bge-reranker-base`（本地 cross-encoder），全部离线、无需 API key。素材源 = 每轮拆卸内容（§7.8 `dismantled.json`），注入点 = 组装消息链锚点块之后（§7.4.1）。

#### 7.9.1 总览与数据流

```
/chat done ──▶ enqueue_extraction(cid, seq) ──▶ 异步 worker
   │                                              └─ 读 dismantled.json turns[seq]
   │                                                 → extract_memories.md 结构化抽取
   │                                                 → MemoryStore.add（去重合并 / infer=False）
   ▼
prepare_turn(user_text) ──▶ assemble_messages ──▶ memory_provider(user_text)
                                                      └─ 混合召回 → 精排 → 融合 → top-k(4)
                                                         → system(长期记忆块) 注入锚点块之后
```

- **抽取时机**：每轮流式 `done` 后由 `routes/chat.py` 调 `svc.enqueue_extraction(cid, seq)`，单 worker 异步执行，**不阻塞流式**。
- **单一 LLM 接入点**：抽取复用 `llm.py` 的 `LLMClient.chat_json`；Mem0 内部 llm 仅构造期占位（`add(infer=False)` 永不调用），`store.py::_build_llm_config()` 是未来换服务端大模型的唯一改动点。

#### 7.9.2 记忆抽取（extraction.py）

- 输入：`dismantled.json` 的 `turns[seq]`（`user{constraints,intent}` / `assistant{conclusion,support}` / `tool_calls[{name,args,call_intent,result_summary}]`）压成紧凑文本（截断 4000 字符）。
- 提示词 `prompts/extract_memories.md` 输出 `{"memories":[{"text","category","importance"}]}`。
- **业务分类 taxonomy**（`types.py` 常量）：

| category | 含义 |
|----------|------|
| `preference` | 用户偏好、风格要求、长期约定 |
| `user_profile` | 用户身份、职业、客观属性 |
| `knowledge` | 已确认事实、结论、项目信息 |
| `task_state` | 进行中任务、待办、决策 |

- 每条带 `importance` 1~5；类别白名单归一（未知归 `knowledge`），importance clamp(1,5)。

#### 7.9.3 存储（store.py，Mem0 封装）

- `Memory.from_config(dict)`：llm=deepseek（占位）/ embedder=huggingface（bge-small-zh, CPU）/ vector_store=qdrant（`path`+`on_disk=True`+**`embedding_model_dims=512`**+`collection_name`）/ reranker=sentence_transformer（bge-reranker, CPU）/ `history_db_path`。
- **`add(text, infer=False)` 原样存储、零 LLM**；先 `_find_duplicate`（语义分 ≥ merge_threshold(0.85) 且 `SequenceMatcher>0.5`）→ 命中则 `update` 合并（importance 取 max，保 created_at），否则新增。
- 元数据：`category` / `importance` / `scope` / `source_conversation_id` / `source_seq`（溯源）。
- **mem0 2.0.x payload 扁平化（调试确认的坑）**：自定义 metadata 被**平铺**进 qdrant payload 顶层（`scope`/`category` 等直接是顶层 key），qdrant 层过滤必须用顶层键 `filters={"user_id":…,"scope":…}`，写 `{"metadata.scope":…}` 会 0 命中；而读取搜索结果时 mem0 会把自定义 keys **重新嵌套**回 `metadata` dict（`core_and_promoted_keys` 之外的全部），文本在 `memory`（源自 payload `data`）。`search`/`get_all` 均如此。
- mem0 的 `score` 字段是内部归一分（相同文本也只有 ~0.5），**不可作绝对阈值**；语义去重用 `rerank_score`（cross-encoder 输出，相同文本 ~1.0）。
- 线程安全：`RLock` 串行全部操作；依赖/模型加载失败 → `_available=False`，所有调用安全返回空。
- qdrant 本地锁：同一 `path` 只允许一个 `QdrantClient` 实例（二次打开报 "already accessed"），多实例/自测须共享同一 `MemoryStore`（`MemoryService(..., store=...)` 可注入）。

#### 7.9.4 检索与融合（retrieval.py）

- **召回**：`store.search(query, top_k=candidates(40), threshold=0.0, rerank=True)` —— mem0 混合检索（语义 + BM25 + 实体提升，fastembed 缺失自动退化纯语义），cross-encoder 精排。
- **精排归一**：`rerank_score` 是无界 logit（可负）→ min-max 归一至 [0,1]；无精排分取 0.5 中性。
- **业务融合打分**（`MemoryConfig` 权重，env 可覆盖）：

```
final = 0.60·rerank_norm + 0.15·recency_decay(半衰期30天) + 0.15·importance_norm
      + 0.05·category_boost(查询命中触发词) + 0.05·source_conf(knowledge>profile>preference>task_state)
过滤 final<min_score(0.35) → 近义去重(文本相似≥0.8 丢弃) → 取 top_k(默认4)
```

- 类别触发词：`preference`（偏好/喜欢/简洁/不要…）、`user_profile`（我是/我的/职业…）、`task_state`（项目/任务/进度…）。
- 输出行格式：`- [偏好·重要3] 用户偏好：要求简洁中文回复（来源 conv-xxx · 2026-08-11）`。

#### 7.9.5 注入（最小侵入：构造期回调）

- `ContextManager.__init__` 增可选 `memory_provider: Callable[[str], list[str]|None]`；`assemble_messages` 在锚点块之后、压缩轮之前追加 `system("长期记忆（跨会话已确认要点）：\n- …")`。
- `registry.py` 从 `app.config["MEMORY_SERVICE"]` 取服务，`svc.enabled` 时注入 `svc.provide_memory_blocks`，否则 None。`prepare_turn`/`finalize_turn` 零改动。
- `provide_memory_blocks` 异常全吞返回 None，**绝不阻断对话**。

#### 7.9.6 管理端点与降级

- 端点见 §8.1（`/memory/list` `DELETE /memory/<id>` `POST /memory/compact`）。
- 降级三级：`MEMORY_ENABLED=0` → 空转，/chat 完全不变；mem0/模型缺失 → 只读可用性为 False，检索注入与入队全空转；无 API_KEY → 抽取停用（llm=None），**检索仍可用**（只读模式）。
- 抽取失败写 `data/memory/errors.jsonl`，不自动重试；`POST /memory/compact` 可整场对话人工重跑。

---

## 8. 客户端 ⇄ Sidecar 协议

- 传输：HTTP/1.1，仅绑定 `127.0.0.1`，随机高位端口。
- 鉴权：每次启动生成随机 token，置入请求 `Authorization: Bearer <token>`；实际端口 + token 经 `data/sidecar.status.json` 由 SidecarManager 发现。

### 8.1 端点

| 端点 | 方法 | 状态 | 用途 |
|------|------|------|------|
| `/healthz` | GET | ✅ | 存活/就绪检查（免鉴权） |
| `/chat` | POST/SSE | ✅ | 流式对话（上下文引擎） |
| `/attachments` | POST(multipart) | ✅ | 上传附件（白名单扩展名，≤100MB） |
| `/attachments/<cid>/<id>` | DELETE | ✅ | 删除附件（文件 + 元数据） |
| `/memory/list` | GET | ✅ | 列出长期记忆（`?limit=&category=&query=`，query 时走语义检索） |
| `/memory/compact` | POST | ✅ | 同步沉降整场对话（人工重跑抽取） |
| `/notes/index` | POST | 🧭 | 笔记保存后增量索引 |
| `/notes/{id}/retrieve` | POST | 🧭 | 笔记本内检索 top-K |
| `/tidy` `/beautify` | POST | 🧭 | 整理 / 美化当前笔记 |
| `/knowledge/index` `/search` | POST | 🧭 | 文档入库 / 知识库语义搜索 |

记忆 DELETE 为 `DELETE /memory/<memory_id>`（不存在 404）。

### 8.2 SSE 事件协议（/chat）

请求体：`{"conversation_id": "...", "message": "...", "depth": "fast|standard|deep"}`（缺省 conversation_id 时服务端新建并回传；`depth` 可选，非法值按默认处理）。响应 `text/event-stream`，**命名事件**：

| 事件 | data | 说明 |
|------|------|------|
| `meta` | `{conversation_id, n, m, depth}` | 会话建立，含当前分级阈值与深度回显 |
| `chunk` | `{content}` | 流式增量（逐字） |
| `done` | `{conversation_id, reply, tier_counts, context_path, dismantled_path}` | 收尾，分级结果 + 落盘路径 |
| `error` | `{error}` | 出错（本轮不回写） |

每条事件格式：`event: <type>\ndata: <json>\n\n`（空行分隔）。

### 8.3 Sidecar 生命周期

```
Electron 启动
  → SidecarManager.spawn(python -m sidecar.app --port 0)
  → 等 data/sidecar.status.json（pid 匹配）→ 读端口+token
  → 轮询 /healthz（带超时）→ ready → 广播 renderer
  → 应用退出 → 优雅 kill 子进程（process.on('exit') 同步兜底）
  → 崩溃 → 指数退避重启（1s→30s 封顶）
  → 父进程被硬杀 → sidecar 父进程看门狗自我回收（防孤儿）
```

### 8.4 已知坑：Flask 流式生成器与请求上下文

视图返回的流式 generator 在**请求上下文弹出后才被消费**，generator 内访问 `current_app`（如 `except` 里的 `logger.exception`）会抛 `RuntimeError: Working outside of application context`，**掩盖真异常**并导致连接中途断开（gateway 侧表现为 undici `terminated`）。修法：

```python
resp = Response(stream_with_context(generate()), mimetype="text/event-stream")
```

---

## 9. 数据存储

### 9.1 上下文引擎 JSON（✅ 当前实际）

每对话一个目录 `data/conversations/<conversation_id>/`（gitignored，原子写入 `*.tmp` + `os.replace`）。字段语义与落盘逻辑见 §7.8：

- **`context.json`** — 分级保留运行态：`{conversation_id, n, m, updated_at, turns[]}`；每轮含 `seq/tier` 及按层级保留的字段（近期=原文、中期=意图摘要/关键结论、远期=事实锚点）。
- **`dismantled.json`** — 全部拆卸内容按 `turns[seq]` 组织：`user{constraints,intent}` / `assistant{conclusion,support}` / `tool_calls[{name,args,call_intent,result_summary}]`。即需求「拆卸的内容用一个 json 文件分对话保存」。
- **`attachments/`**（对话目录下）— 上传附件字节（`<id><ext>` 命名）+ `attachments.json` 元数据（id/name/size/mime/stored_name/uploaded_at）。当前阶段**仅保存展示，不注入 AI 上下文**；后续知识库/检索阶段复用。
- **`data/threshold_stats.json`** — 各对话完成轮数，用于 N/M 动态调整。

### 9.2 长期记忆存储（✅ 当前实际，见 §7.9）

`data/memory/`（gitignored）：

| 路径 | 内容 |
|------|------|
| `qdrant/` | qdrant on-disk 向量库（collection `long_term_memory`，COSINE，512 维） |
| `history.db` | mem0 事件历史 SQLite |
| `errors.jsonl` | 抽取失败记录（`{conversation_id, seq, error}`，供 compact 重跑） |
| `models/` | HF 模型缓存（`HF_HOME` 指向此处，离线可预拷贝） |

### 9.3 规划中

- 客户端 SQLite（主进程，`better-sqlite3`）：`notebook` / `note`（TipTap JSON）/ `attachment`，见 §10.1。
- 知识库集合（sidecar，复用 qdrant 设施）：`knowledge_base`，见 §10.2。

---

## 10. 规划中模块

### 10.1 客户端 SQLite（Electron 主进程）🧭

```sql
CREATE TABLE notebook (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE note (
  id          TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebook(id),
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,      -- TipTap JSON
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,   -- 供增量同步
  deleted_at  INTEGER
);
CREATE TABLE attachment (
  id   TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES note(id),
  path TEXT NOT NULL,
  hash TEXT NOT NULL,
  mime TEXT
);
```

> 笔记向量**不在**客户端，改由 sidecar 写入 Milvus。

### 10.2 qdrant 集合（sidecar）✅ 长期记忆 / 🧭 其余

```python
long_term_memory = {"id","memory","metadata:{category,importance,scope,source_conversation_id,source_seq}",
                    "embedding(dim=512)"}   # ✅ 已实现（qdrant COSINE + mem0 管理）
knowledge_base  = {"item_id","kind:note_ref|document","title","added_at","embedding"}   # 🧭 复用同一套 qdrant+mem0 设施
note_index      = {"note_id","notebook_id","updated_at","embedding"}                     # 🧭
```

### 10.3 AI 能力扩展 🧭

- **长期记忆**：✅ 已落地（§7.9）。跨会话「还记得上次…」由 Mem0 + qdrant 承载；后续可扩展笔记本级 scope 隔离（`MEMORY_SCOPE=notebook:<id>`）。
- **知识库**：精选笔记引用 + 外部文档；文档上传 → 解析 → 向量化 → 入库；提供语义搜索，**不参与** AI 助手上下文。复用 §7.9 的 qdrant + mem0 向量设施。
- **整理/美化**：当前笔记 REST 调用，结果与原文 diff 展示、一键应用。
- **上下文组装升级**：当前编辑笔记 + 笔记本内相关笔记（向量检索）+ 长期记忆 → 组装消息链（§7.4.1 扩展）。

---

## 11. 开发与验证

| 操作 | 命令 / 方法 |
|------|-------------|
| 类型检查 | `npm run typecheck`（node + web 双 tsconfig，strict） |
| 启动开发 | `npm run dev`（窗口 + sidecar 自动拉起） |
| 上下文引擎自测 | `python -m sidecar.scripts.self_test`（真实 API）/ `--dry-run`（FakeLLM 离线） |
| 长期记忆自测 | `python -m sidecar.scripts.self_test_memory`（store 增/查/并/删 + 抽取 + 检索融合；依赖缺失优雅跳过） |
| 端到端（UI 全链路） | `npx electron-vite dev -- --remote-debugging-port=9222` + Node 全局 WebSocket 发 CDP `Runtime.evaluate` 驱动真实发送并断言事件流 |
| 协议冒烟 | `curl -N -X POST http://127.0.0.1:<port>/chat -H "Authorization: Bearer <token>" -d '{"message":"..."}'` |
| 记忆端到端 | 会话 A 声明偏好 → 等 2s（异步沉降）→ 会话 B 问偏好 → 组装链含「长期记忆」块且回复引用；`curl .../memory/list` / `POST /memory/compact` / `DELETE /memory/<id>` |

已验证：分级全流程、工具拆卸、续对话恢复、SSE meta/chunk/done、无 token 401、崩溃重启、硬杀后看门狗自清、UI 流式逐字渲染；长期记忆 store 增/查/并/删、FakeLLM 抽取、检索融合注入、`MEMORY_ENABLED=0` 空转。

---

## 12. 离线降级

| 状态 | AI 相关 | 笔记功能 |
|------|---------|---------|
| 在线 | 完整（对话/整理/美化/索引/记忆）；记忆抽取走在线 LLM | 完整 |
| 断网 | 对话降级；**记忆检索仍可用**（本地向量/精排），仅抽取停用（只读模式）；笔记保存照常 | 完整 |
| 模型超时/限流 | 重试 + 错误提示；记忆注入/入队异常全吞，不阻断对话 | 不受影响 |

---

## 13. 安全基线

- Electron：`contextIsolation: true`、`sandbox: true`、CSP 严格。
- Sidecar：仅绑定 127.0.0.1；请求带随机 token；`conversation_id` 做路径穿越防护。
- 附件上传：扩展名白名单（PDF/DOCX/XLSX/TXT/MD/HTML/PNG/JPG）+ `MAX_CONTENT_LENGTH` 100MB（超限 413）；文件名取 basename、`conversation_id` 校验，防路径穿越。
- 在线 API 的 key 存于 sidecar 本地配置（`temp/.env`，gitignored），不写死、不上传、不入库；后续移入系统凭据区。
- 文档解析对恶意文件做超时与体积上限保护（规划中）。

---

## 14. 云端预留（本版不实现）

- `note.updated_at` 已就位，便于增量同步。
- sidecar 未来可独立部署为远程服务（架构不变，仅把「本地 HTTP」改为「远程 HTTPS + 鉴权」），预留 `gateway` 抽象。
- 多设备/共享知识库待服务端设计。

---

## 15. 待后续确认

- 记忆「遗忘」策略：当前仅时间半衰期衰减（30 天）+ 人工删除，无容量上限/自动归档，待定。
- 笔记本级 scope 隔离：当前 `MEMORY_SCOPE=global` 全局共享，接笔记本体系后按 `notebook:<id>` 隔离。
- 记忆去重阈值（`merge_threshold=0.85` / 文本相似 0.5）是否需要随实测调参。
- Python 3.14 生态兼容：torch/sentence-transformers 需 cp314 wheel，安装失败时的降级路径（fastembed/llm_reranker）已验证为可选。
- 文档解析支持的格式清单与体积上限。
- sidecar 打包方式（PyInstaller vs 要求用户装 Python 环境）。
- 是否需要多窗口/多标签编辑。
- 上下文引擎对「整理/美化」等能力的复用方式（拆卸/缩减提示词可否通用）。
