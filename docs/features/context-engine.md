# 上下文工程（Context Engine）

> 模块：Sidecar `sidecar/context/`（ContextManager、分级保留、缩减、拆卸）。
> 本文档描述"如何把无限长的对话压缩进有限上下文"：消息分级、精简/压缩策略、工作区拆卸、磁盘持久化。
> 状态：✅ 已实现。接服务端只需替换 `llm.py`。

## 1. 总体思想

长对话不可能整段塞进窗口。ContextEngine 的做法：

1. **分级保留**：把历史消息分成 **T0（锚点）/ T1（近端）/ T2（中段）/ T3（远端）** 四级，只有前三级进窗口。
2. **近端消息**：窗口内保留完整原文。
3. **中段消息**：**摘要压缩**（一次性 prompt 把若干条压成一条），标题行展开时再回填原文。
4. **远端消息**：**每轮演进摘要**（rolling summary），不进窗口但持久化。
5. **工作区拆卸**：T3 级消息拆出窗口后，还原成带元数据的 JSON 存盘，可按需回载。

## 2. 消息分级与保留（N=8 / M=16）

- **N（T0 锚点数）**：默认 `N=8`，最靠近当前上下文的锚点级消息原文保留。
- **M（T1 近端数）**：默认 `M=16`，近端完整消息条数。
- **配置**：`CONTEXT_T0_ANCHOR_N`、`CONTEXT_T1_KEEP_M`（前缀 `CONTEXT_`，见 [knowledge-rag.md](knowledge-rag.md) 同级配置风格）。

消息从对话归档 JSON 读取（turns 带 `tier` 标记与时间戳），按时间正序重放进窗口：

```
[T0 锚点   ][T1 近端原文 ][T2 中段摘要][系统提示+锚点]
  ↑ 分级结果回写 turn 的 tier 字段，磁盘同步
```

`meta` SSE 事件回传当前 `{n, m, depth}`，让前端可见分级阈值。

## 3. 组装消息链（prepare_turn）

`POST /chat` 每次发消息时按序组装：

1. 系统提示（模型角色说明，见 `sidecar/prompts/system.md`；`@organize` 追加文档整理说明）。
2. **锚点级**：T0 原文 + 相关工具结果。
3. **压缩级**：T2 段的 rolling summary / 摘要。
4. **近端级**：T1 原文，逐条展开，标题可点击回填。
5. 当前用户输入。

**深度档位（depth）**：

| depth | 语义 | 表现 |
|-------|------|------|
| `fast` | 轻量 | 只带 T0 锚点 + 最近若干条 |
| `standard` | 标准 | 全链（锚点+摘要+近端） |
| `deep` | 深度 | 全链 + 更宽的回溯窗口 |

## 4. 缩减与压缩策略

- **成本函数**：按 token 估算每条消息占用，超出窗口预算时从远端逐级降档。
- **批量压缩**：对 T2 中段消息分组，一次 prompt 产出浓缩摘要，替换原消息进窗口。
- **标题化**：T1 超长消息折叠为标题（供点击展开原文）。
- 分级与压缩结果回写会话 JSON，**跨轮持久化**，重启后按 conversation_id 从磁盘恢复（`sidecar/registry.py`）。

## 5. 工作区拆卸（拆卸引擎）

- **触发**：消息落入 T3（远端）即被"拆出"工作区。
- **产物**：`data/conversations/<cid>/context.jsonl` 与 `turns.json`，每条记录 `{tier, text, ts, summary}`，带完整元数据可回载。
- **目的**：窗口只放「摘要 + 近期」，历史细节留在磁盘，需要时（如用户问"刚才你说过什么"）回查。
- `done` 事件携带 `context_path` / `dismantled_path` 指向本轮回写的两处落盘文件，供调试与校验。

## 6. 长期记忆

对话的跨会话持久知识（Mem0 + qdrant 向量库）单列，见 [long-term-memory.md](long-term-memory.md)。

## 7. 接服务端只换 llm.py

上下文引擎与 LLM 解耦：所有模型调用收敛在 `sidecar/llm.py`（流式/非流式、DeepSeek/Qwen 适配、错误重试）。替换为任意 OpenAI 兼容网关只需改这一个文件，分级/拆卸/压缩逻辑不动。

## 8. 关联文档

- 对话转发与 SSE 时序：见 [chat-pipeline.md](chat-pipeline.md)。
- 长期记忆：见 [long-term-memory.md](long-term-memory.md)。
- 数据存储位置与格式：见 `docs/client-architecture.md` §10。
