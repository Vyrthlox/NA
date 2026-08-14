#!/usr/bin/env python3
"""一次性计时验证：上传改增量后，向已有 KB 追加小文件只重建该文件（updated=1，elapsed 显著下降）。

用法（仓库根目录）：python temp/kb_timing_check.py
数据写入 temp/kb_timing_check_data/，跑完不清理（可复查）。
"""
from __future__ import annotations

import shutil
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import os  # noqa: E402
os.environ.setdefault("HF_HOME", str(REPO_ROOT / "data" / "memory" / "models"))
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

from sidecar.services.context.config import SidecarConfig  # noqa: E402
from sidecar.services.context.llm import FakeLLMClient  # noqa: E402
from sidecar.services.knowledge.config import KnowledgeConfig  # noqa: E402
from sidecar.services.knowledge.service import KnowledgeService  # noqa: E402


def sample(title: str) -> str:
    parts = [f"<h1>{title}</h1>"]
    for i in range(30):
        parts.append(
            f"<p>{title}内容段{i}：RAG 混合检索结合 BM25 关键词召回与 FAISS 向量召回，"
            f"经 RRF 排名融合后用重排模型精排，送入大模型生成回答。索引用 bge-small-zh 编码为 512 维向量。"
            f"chunk 控制在 256 到 512 token，相邻块 50 token 重叠，语义断裂点强制切分。</p>"
        )
    return "".join(parts)


class _FakeRouter:
    def get(self, provider: str, depth: str):
        return FakeLLMClient()


tmp = Path("temp/kb_timing_check_data")
shutil.rmtree(tmp, ignore_errors=True)
tmp.mkdir(parents=True, exist_ok=True)

cfg = KnowledgeConfig(data_dir=tmp)
ctx_cfg = SidecarConfig(data_dir=tmp)
svc = KnowledgeService(ctx_cfg, cfg, llm_router=_FakeRouter())
svc._ready = True

svc.embedder.embed(["预热"])  # 冷加载嵌入模型，避免计入首轮计时

rec = svc.create_kb("计时库")
kb_id = rec["id"]

# 首轮：传 6 个样例文件（新库无既有索引 → 全量）
first = [(f"doc{i}.html", sample(f"文档{i}").encode("utf-8")) for i in range(6)]
t0 = time.time()
st1 = svc.upload_files(kb_id, first)
t1 = time.time()
print(f"首轮 6 文件: stats.elapsed={st1['elapsed']}s 墙钟={t1-t0:.2f}s "
      f"updated={st1['updated']} skipped={st1['skipped']} chunks={st1['chunks']}")

# 次轮：追加 1 个极小文件（应走增量，只重建该文件）
tiny = "<h1>冷门锚点</h1><p>这一段包含唯一锚点词：紫罗兰雷达。只有该文档应被重建。</p>"
t2 = time.time()
st2 = svc.upload_files(kb_id, [("追加/极小.html", tiny.encode("utf-8"))])
t3 = time.time()
print(f"次轮 1 文件: stats.elapsed={st2['elapsed']}s 墙钟={t3-t2:.2f}s "
      f"updated={st2['updated']} skipped={st2['skipped']} chunks={st2['chunks']}")

res = svc.search("紫罗兰雷达", kb_id=kb_id)
print(f"检索「紫罗兰雷达」命中 {len(res)} 条；首条 doc_id={res[0].doc_id if res else None}")
hit = bool(res) and res[0].doc_id == "追加/极小.html"
ok = st2["updated"] == 1 and hit and st2["elapsed"] < max(0.5, st1["elapsed"] * 0.3)
print(f"\n结论: updated={st2['updated']}（应=1）| 新文件可检索={hit} | "
      f"elapsed 下降至首轮 {st2['elapsed']}/{st1['elapsed']} => {'✓ 增量生效' if ok else '✗ 异常'}")
sys.exit(0 if ok else 1)
