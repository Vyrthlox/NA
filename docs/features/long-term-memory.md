# 长期记忆（Long-term Memory）

> 模块：Sidecar `sidecar/memory/`（Mem0 + qdrant 向量库）。
> 本文档描述跨会话持久知识：从对话中抽取事实 → 写入向量库 → 下次对话检索注入。
> 状态：✅ 已实现（对话级别；用户档案级记忆为后续增强方向）。

## 1. 解决的问题

上下文引擎（[context-engine.md](context-engine.md)）只保证**单会话内**的前后文；跨会话时用户重申过的偏好、事实（"我叫 XX，用中文回复""偏好简约风格"）会丢失。长期记忆把这些事实沉淀到向量库，新会话按相关性召回注入。

## 2. 数据流

```
对话 turn（finalize_turn 之后）
        │ 抽取事实（Mem0 的 add/update/delete 语义）
        ▼
   qdrant 向量库（本地，collection per 维度）
        │ 新会话组装消息链时 检索 top-k 相关记忆
        ▼
   注入系统提示/锚点段
```

- **抽取**：每轮对话收尾时，把「值得长期记住的事实」从回复与用户输入中抽出，走 Mem0 的 add/update/delete 语义（同一实体新信息**更新**而非重复插入）。
- **存储**：事实向量化后写入 qdrant（`data/` 下本地向量文件），带来源时间戳。
- **检索注入**：新会话 `prepare_turn` 时按当前输入向量检索 top-k，命中则注入系统提示，让模型"记得"跨会话上下文。
- **分级联动**：长期记忆与 T0 锚点并列进窗口；强相关的历史甚至直接作为锚点原文展开。

## 3. 存储位置

| 内容 | 位置 |
|------|------|
| 向量库 | `data/memory/`（qdrant 本地存储） |
| 记忆事实 JSON | `data/memory/` 下按 collection 分文件 |

## 4. 已知边界

- 抽取质量依赖模型；低相关事实可能污染召回，故检索 top-k 设上限并允许阈值过滤。
- 事实更新走 Mem0 语义，避免同一事实重复累积。

## 5. 关联文档

- 上下文分级/拆卸：见 [context-engine.md](context-engine.md)。
- 数据存储总览：见 `docs/client-architecture.md` §10。
