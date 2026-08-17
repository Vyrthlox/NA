# 知识库管理与 AI 问答（Knowledge Base）

> 模块：Renderer `src/lib/use-knowledge.ts`、Main `electron/main/knowledge/`、Sidecar `sidecar/routes/knowledge.py`（索引/检索）。
> 本文档描述"知识库"这一应用功能：库的增删、文件上传、索引状态、以及基于知识库的 AI 问答集成。
> **索引策略与检索算法（BM25/FAISS/RRF/级联重排、KN_* 配置）见 `docs/knowledge-rag.md`**，本文档只写功能形态与接入。
> 状态：✅ 已实现（UI + 接入）。

## 1. 功能总览

用户可建立多个知识库，上传文档建立索引；聊天时开启「基于知识库」开关，提问**只基于该库内容**回答并附引用来源（citations）。

```
┌─────────────────────┐      IPC       ┌───────────────────┐      HTTP       ┌────────────────────┐
│ 知识库管理页 (UI)     │ ──────────────▶ │ Main knowledge:*  │ ───────────────▶ │ sidecar /knowledge  │
│ 库列表/建库/删库/传文件│ ◀────────────── │                  │ ◀─────────────── │ 索引/检索/query     │
└─────────────────────┘  knowledge:status└───────────────────┘   Bearer token   └────────────────────┘
```

## 2. 知识库管理（IPC）

| 通道 | 方向 | 说明 |
|------|------|------|
| `knowledge:status` | handle | sidecar 索引引擎状态（就绪前管理操作禁用） |
| `knowledge:kbs` | handle | 列出全部知识库 |
| `knowledge:kbs:create` | handle | 新建知识库 |
| `knowledge:kbs:delete` | handle | 删除知识库（连同索引） |
| `knowledge:kbs:files` | handle | 某库已索引文件清单 |
| `knowledge:kbs:upload` | handle | 上传文档触发索引（落盘 + 建向量） |
| `knowledge:kbs:delete-file` | handle | 删除库内单个文档索引 |
| `knowledge:search` | handle | 显式检索（供页面调试/预览命中） |
| `knowledge:query` | handle | AI 问答：单次返回 `{answer, citations, conversation_id}` |
| `knowledge:reindex` | handle | 全量重建索引 |

## 3. 索引状态与交互

- 上传文档后进入索引队列，UI 显示状态（排队/索引中/完成/失败）。
- 索引中重复上传同文件按文档指纹去重；删文件即删对应向量与倒排条目。
- 索引引擎未就绪时，上传按钮与「基于知识库」开关均禁用，顶部状态条提示。

## 4. 基于知识库的 AI 问答（聊天接入）

- 聊天输入区「基于知识库」开关 + 库下拉：开启后 `send()` 走**纯知识库问答**，不掺普通聊天上下文（`use-chat.ts` 的 `useKb` 分支）。
- 调用 `window.api.knowledge.query({query, kb_id, provider, depth, conversation_id})`：
  - sidecar 只检索该库 → 混合召回 → 重排 → 送 LLM 生成答案；
  - 返回 `answer` 渲染为 assistant 气泡，`citations` 渲染为气泡下方引用 chips（点击可看原文片段）。
  - 该轮问答由 sidecar 落盘到会话（历史对话可见，`loadConversation` 恢复 citations）。
- **与普通对话的区别**：不走 SSE 流式，单次返回；不进入上下文分级（`kind=kb`）；`conversation_id` 可新建会话并回传，前端采纳以对齐历史列表。
- 状态约束：`@organize` 命令时 KB 开关不参与。

## 5. 检索/索引细节

文档正文切块、增量重建、混合召回（BM25 + FAISS 向量）与 RRF 合并、级联重排、生成策略，以及 `KN_*` 配置项全表 —— **全部见 [knowledge-rag.md](../knowledge-rag.md)**（该文档即 RAG 知识库索引策略的说明文档）。

## 6. 降级路径

- 索引引擎（sidecar）未启动 → 操作禁用 + 状态提示。
- FAISS/numpy 缺失 → 向量检索降级为纯 BM25 关键词（见 knowledge-rag.md 降级路径章节）。

## 7. 关联文档

- RAG 索引策略与配置：见 [knowledge-rag.md](../knowledge-rag.md)。
- 聊天链路与 `useKb` 分支：见 [chat-pipeline.md](chat-pipeline.md)。
