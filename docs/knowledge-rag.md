# NA RAG 知识库 — 检索与索引策略（技术文档）

> 模块：`sidecar/services/knowledge/`。本文档描述 RAG 知识库的**索引策略**与**检索策略**，含 2026-08-12 检索速度优化后的最终形态、取舍与实测数据。
> 依赖：`jieba`（分词，缺失降级字符 bigram）、`faiss`（向量检索，缺失走 numpy 兜底）、`sentence-transformers`（嵌入 + 重排）、在线 LLM（生成回答）。

## 1. 总体数据流

```
┌─ 索引阶段（reindex_kb，变更即重建）─────────────────────────────────┐
│  用户知识库 files/*.html|*.txt|*.pdf → 切分 → 分词 → BM25 建索引      │
│                                        → 嵌入(bge-small-zh) → 向量索引 │
│                                        → 落盘 data/knowledge/<kb_id>/* │
└────────────────────────────────────────────────────────────────────┘
┌─ 检索阶段（search / query）─────────────────────────────────────────┐
│  Query → BM25(auto) + 精确BM25(触发) + FAISS → RRF(k=60) → 去重      │
│        → 候选池裁剪 → (候选≤final_top? 跳过重排) → 级联重排(截断打分) │
│        → Top-3 → LLM 生成（带 [引用i] 标注）                          │
└───────────────────────────────────────────────────────────────────┘
```

### 1.1 数据模型（用户自建知识库，2026-08-12 重构）

知识库由用户**自建**（不再自动索引 `data/library/`）。注册表 `data/knowledge/kbs.json` → `[{id, name, created_at}]`；每个 KB 有独立索引目录 `data/knowledge/<kb_id>/`：

| 路径 | 内容 |
|---|---|
| `files/` | 用户上传的文件副本（保留子目录相对路径，`doc_id` = 相对此目录的 posix 路径） |
| `chunks.jsonl` | 切分后的 chunk 清单 |
| `faiss.index` / `faiss.npy` | FAISS 索引 / numpy 向量副本 |
| `index_meta.json` | 文档清单 `(mtime, size)`，增量重建依据 |

服务持有共享的 `Embedder` 与 `CascadeReranker`（模型只加载一份）；每个 KB 的 `store/bm25/vector` 懒加载缓存于 `_kb`，首次 search/query 时从磁盘 `load_index()` 恢复。

**变更即重建**：对 KB 的任何更改（创建 / 上传文件 / 删除文件 / 删除 KB）与重建看成一个过程——服务端在同一个同步调用里完成「写文件 + reindex」后返回 stats，前端用「正在更改」加载条掩盖。旧的 `/knowledge/reindex` 保留为兼容/自测端点（重建全部 KB）。

## 2. 索引策略

### 2.1 文档切分（chunker.py）

- 结构边界硬切：`h1`~`h6` / `p` / `li` 为段落单元；`.txt` / `.md` 转义后按段落处理。
- 语义校验：相邻块 embedding 余弦 < 0.5 强制切分。
- 窗口：256~512 token，相邻块 50 token overlap；`chunk_id = doc_path::seq`。

### 2.2 增量重建（reindex_kb）

- `index_meta.json` 记录每文档 `(mtime, size)`；未变文档**复用既有 chunk 与 embedding**（新向量按 position 切片对齐）。
- 新 chunk 但 embedding 不可用时整组丢弃向量，防错位。
- **上传/删除走增量**（`reindex_kb(id, incremental=True)`，2026-08-14 起）：新上传文件不在 `index_meta` → 判为 changed，只重建受影响文档，未变文档复用既有 chunk/向量；`/knowledge/reindex` 仍可显式全量。
- 增量前先 `_load_kb` 载入磁盘基线（否则 `kb.store.chunks` 为空，`incremental=True` 也会落成全量）；既有 chunk 无向量可复用且 embedding 可用时一并重嵌，保证 `vectors` 行数与 `chunks` 对齐。
- **变更即重建**：上传/删除文件在同一个调用里触发 rebuild，UI 以「正在更改」掩盖，无手动重建按钮。

**上传耗时优化（2026-08-14，问题定位与实测）**：此前 `upload_files` 强制 `incremental=False`（全量），且 `reindex_kb` 开头不加载磁盘索引——每次上传都重嵌**全库**（切分语义校验还逐候选边界单条 embed，成本随库文档数线性涨），小文件上传 ~1min。修复 3 处（`service.py`）：① `reindex_kb` 增量前 `_load_kb` 载入基线；② `upload_files` 改 `incremental=True`；③ kept 无向量可复用且 embedding 可用时一并重嵌防错位。实测（临时库，嵌入模型已预热）：6 文件首轮全量 **6.5s** → 追加 1 小文件 **0.07s**（`updated=1`、`skipped=6`，约 **93×**）。注意 `stats.updated` 语义变化：从「全库文件数」改为「受影响文档数」；`delete_kb_file` 同样受益。

### 2.3 分词（tokenizer.py）

- 手写 `_SEG_RE` 交替提取「CJK 连续串」+「ASCII 字母数字串」，两者都保留；中文走 jieba 词切（缺失降级字符 bigram），英文/数字按连续串整体成 token（保留 `v1.2.3`、`BUG-123` 内部结构）。
- 全部 token 小写归一。

### 2.4 向量索引（vector.py）

按语料规模选型，落盘 `faiss.index`：

| 规模 | 索引 |
|---|---|
| < 100k | IndexFlatIP（暴力点积） |
| 100k ~ 1M | IVF + Flat（`nlist=4·√N`，`nprobe=16`） |
| > 1M | IVF + PQ（`m=16`） |

`KN_FAISS=0` 强制 numpy 暴力点积兜底（缺失 faiss 时自动走此路径）。

## 3. 检索策略（2026-08-12 优化后）

### 3.1 混合召回

- **BM25（auto）**：按 chunk token 数选短/长参数 —— 短 `{k1=1.2, b=0.5}`、长 `{k1=1.5, b=0.8}`（阈值 300 token），Top-50。
- **精确 BM25**（`k1=0, b=0.75`）：query 全为标识符型 token（无中文，如 `IndexFlatIP`）**或**含引号短语 `"…"`/`「…」` 时触发，并入 RRF，来源标记 `exact`。
- **FAISS 向量召回**：`embed_query` 后 Top-50。

### 3.2 RRF 融合 + 去重（rrf.py）

- `RRF(k=60)` 融合三路；`chunk_id` 精确去重（保最高分）；相似度去重（余弦 > 0.92 丢弃，保留高分者）。
- **候选池裁剪：`rrf_candidates` 默认 15**（原 40）。级联重排只保留 `rerank_light_top=10`，喂 15+ 纯浪费首级打分 —— 大库下首级成本省 ~2.7×。

### 3.3 级联重排（rerank.py）

两段式，**默认只跑轻量段**：

1. **轻量** `cross-encoder/ms-marco-MiniLM-L-6-v2`：对候选打分（**输入截断到 `KN_RERANK_MAX_TOKENS=128`**，仅打分截断、展示仍全文），选 top-10。
2. **高精度** `BAAI/bge-reranker-v2-m3`：从 10 中筛 final_top=3~5。**`KN_RERANK_HEAVY` 默认 0（关闭）** —— 见 §4。

### 3.4 关键优化点（改动后）

| 优化 | 默认 | 说明 |
|---|---|---|
| 重排输入截断 | `KN_RERANK_MAX_TOKENS=128` | CrossEncoder 成本随**文本长度**线性涨（115-token ≈236ms/对、15-token ≈36ms/对），与候选数关系小；截断后长 chunk 兜底 |
| 小池跳过重排 | 自动 | 候选数 ≤ final_top 时直接按 RRF 顺序返回 —— 重排只能重排/少选，无法再缩小集合，稀疏/精确查询免重排 |
| 高精度重排默认关闭 | `KN_RERANK_HEAVY=0` | 本机 CPU 首查加载 2.2G 模型卡 ~12.5s、每次 10 对 ≈15-20s，逐查询不可行；关闭后即「加载失败→回退轻量」的现状，只是不再白等 |
| 候选池收窄 | `KN_RRF_CANDIDATES=15` | 级联只留 top-10，喂 15+ 浪费首级打分 |
| warmup 预载轻量模型 | — | `_warmup()` 后台 `light_available()`，首查不再现加载 |

### 3.5 生成（query）

- Top-3 → 拼 `[引用i]（来源 doc · section）\n文本` 上下文（`gen_max_chars=16000` 截断）→ 复用 LLMRouter（默认 deepseek/fast）→ 带引用的回答。
- citations 携带 `sources`（bm25/vector/exact/rrf），UI 单路调用即可渲染来源徽标。

## 4. 检索速度优化 — 问题定位与实测

**瓶颈定位（真实数据，本机）**：`search()` 全程 ≈ 1.8s，其中 `rerank` 占 **~100%**（tokenize/BM25/embed/vector/RRF/dedupe 全部 sub-ms）；重排成本由送入文本长度决定，不是候选数。

**三个结构性问题**：
1. 首查固定卡 ~12.5s（加载 2.2G bge-reranker-v2-m3，模型已缓存仍是 CPU 加载耗时）。
2. UI 并行跑 `/knowledge/search` + `/knowledge/query`，而 query 内部又跑一遍完整检索 → 每问检索两遍（被共享锁串行）。
3. 首级给第 11 名之后的候选打分，纯浪费。

**实测对比（真实数据 `data/library/`，8 chunk）**：

| 查询 | 优化前 | 优化后 |
|---|---|---|
| `RAG 检索是怎么做的？` | ~1.8s | **116ms** |
| `知识库有哪些功能` | ~1.8s | **125ms** |
| `IndexFlatIP`（1 候选，小池跳过） | ~1.8s | **119ms** |
| 首次查询 12.5s heavy 加载 | 每次进程首查 | **消失** |

## 5. 配置总表（`KN_*`，环境变量覆盖）

| 配置 | 默认 | 说明 |
|---|---|---|
| `KNOWLEDGE_ENABLED` | 1 | 模块开关 |
| `KN_EMBED_MODEL` | `BAAI/bge-small-zh-v1.5` | 嵌入模型（512 维） |
| `KN_RERANK_LIGHT_MODEL` | `cross-encoder/ms-marco-MiniLM-L-6-v2` | 轻量重排 |
| `KN_RERANK_HEAVY_MODEL` | `BAAI/bge-reranker-v2-m3` | 高精度重排 |
| `KN_RERANK_HEAVY` | 0 | 高精度重排开关（默认关，`--heavy` 自测开启） |
| `KN_RERANK_MAX_TOKENS` | 128 | 重排打分文本 token 上限（仅打分截断） |
| `KN_RRF_CANDIDATES` | 15 | 融合后送入重排的候选上限 |
| `KN_RERANK_LIGHT_TOP` | 10 | 轻量重排选出前 N |
| `KN_FINAL_TOP` | 3 | 最终 Top-N（≤5） |
| `KN_BM25_TOP_K` / `KN_VECTOR_TOP_K` | 50 / 50 | 召回 Top-K |
| `KN_RRF_K` | 60 | RRF 常数 |
| `KN_DUP_COSINE` | 0.92 | 相似度去重阈值 |
| `KN_CHUNK_MIN` / `MAX` / `OVERLAP` | 256 / 512 / 50 | 切分窗口（token） |
| `KN_SEM_THRESHOLD` | 0.5 | 语义切分阈值 |
| `KN_SHORT_DOC_THRESHOLD` | 300 | 短/长 BM25 参数切换阈值 |
| `KN_BM25_SHORT_{K1,B}` | 1.2 / 0.5 | 短 chunk 参数 |
| `KN_BM25_LONG_{K1,B}` | 1.5 / 0.8 | 长 chunk 参数 |
| `KN_BM25_EXACT_{K1,B}` | 0.0 / 0.75 | 精确匹配参数 |
| `KN_GEN_MAX_CHARS` | 16000 | 注入上下文上限 |
| `KN_FAISS=0` | — | 强制 numpy 向量兜底 |
| `HF_HOME` / `HF_ENDPOINT` | `data/memory/models` / hf-mirror | 模型缓存与下载端点 |

## 6. 端点

### 6.1 知识库管理（KB CRUD）

| 端点 | 说明 |
|---|---|
| `GET /knowledge/status` | 索引状态（available + `kbs:[{id,name,created_at,files,chunks,indexed}]`，不触发重建） |
| `GET /knowledge/kbs` | 知识库列表（同上，`{kbs:[...]}`） |
| `POST /knowledge/kbs` `{name}` | 创建知识库（空名 400）→ `{id, name}` |
| `DELETE /knowledge/kbs/<id>` | 删除知识库（索引目录 + 注册表；不存在 404）→ `{ok}` |
| `GET /knowledge/kbs/<id>/files` | 文件列表 → `{kb_id, files:[{rel,name,size,mtime}]}` |
| `POST /knowledge/kbs/<id>/files` | **multipart** 上传（多 `file` part，`filename`=相对路径；拒绝 `..`/绝对路径 400）→ `{ok, stats}`（**变更+重建一体**） |
| `DELETE /knowledge/kbs/<id>/files` `{rel}` | 删除文件（不存在 404）→ `{ok, stats}`（变更+重建一体） |

### 6.2 检索 / 生成 / 重建

| 端点 | 说明 |
|---|---|
| `POST /knowledge/reindex` `{incremental?}` | 重建全部 KB（兼容/自测） |
| `POST /knowledge/search` `{query, kb_id?, top_n?}` | 混合检索 → 片段列表（带 sources）；`kb_id` 缺省时跨全部 indexed KB 合并 |
| `POST /knowledge/query` `{query, kb_id?, provider?, depth?, top_n?, conversation_id?}` | 检索 + LLM 生成 → `{answer, citations, conversation_id}`（citations 带 sources；该轮问答落盘到历史会话，conversation_id 缺省时服务端新建并回传） |

除 `/healthz` 外均需 Bearer token。kb_id 给定但该 KB 为空时 search/query 返回 503；query 无 LLM key 返回 503。

## 7. 降级路径（逐级回退，sidecar 不挂）

| 依赖缺失 | 行为 |
|---|---|
| jieba | 分词降级字符 bigram |
| faiss | 向量检索降级 numpy 暴力点积 |
| 嵌入模型 | 纯 BM25 检索（向量路停用） |
| 轻量重排模型 | 保持 RRF 顺序 |
| 高精度重排模型 | 默认关闭；开启但加载失败 → 回退轻量结果 |
| LLM key | search 仍可用，query 返回 503 |

服务懒加载 + `RLock` 并发安全；`start()` 后台温载不阻塞 `/chat`。

## 8. 自测与验证

- `PYTHONIOENCODING=utf-8 python -m sidecar.scripts.self_test_knowledge`（默认轻量，FakeLLM 离线）
- `--real-llm`：生成走真实 API；`--heavy`：置 `KN_RERANK_HEAVY=1` 额外验证高精度重排
- UI 全链路：`npx electron-vite dev -- --remote-debugging-port=9222` + `node temp/cdp_knowledge.mjs <wsUrl>`（单路调用下片段随回答一起返回，脚本等片段放宽到 40s）
