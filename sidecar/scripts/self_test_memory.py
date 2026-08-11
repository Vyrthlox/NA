#!/usr/bin/env python3
"""长期记忆自测：store 增/查/并/删 + 抽取 + 检索融合。

用法（仓库根目录执行）：
    python -m sidecar.scripts.self_test_memory            # 真实 mem0 + FakeLLM 抽取
    python -m sidecar.scripts.self_test_memory --real-llm  # 抽取也走真实 API（需 temp/.env key）

依赖缺失（mem0/模型未装）时 store 部分优雅跳过并输出原因，纯逻辑部分（抽取/融合）仍跑。
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path

# 仓库根目录 = sidecar/scripts/self_test_memory.py 向上 3 级
REPO_ROOT = Path(__file__).resolve().parents[2]

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

sys.path.insert(0, str(REPO_ROOT))

# 模型缓存落仓库 data/memory/models（跨测试复用，避免每次重下 bge 模型）
import os  # noqa: E402
os.environ.setdefault("HF_HOME", str(REPO_ROOT / "data" / "memory" / "models"))
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

from sidecar.services.context.config import SidecarConfig  # noqa: E402
from sidecar.services.context.llm import FakeLLMClient  # noqa: E402
from sidecar.services.context.storage import ConversationStorage  # noqa: E402
from sidecar.services.memory.config import MemoryConfig  # noqa: E402
from sidecar.services.memory.extraction import MemoryExtractor  # noqa: E402
from sidecar.services.memory.retrieval import MemoryRetriever  # noqa: E402
from sidecar.services.memory.service import MemoryService  # noqa: E402
from sidecar.services.memory.store import MemoryStore  # noqa: E402

FAIL = 0


def check(name: str, cond: bool, detail: object = "") -> None:
    global FAIL
    status = "PASS" if cond else "FAIL"
    if not cond:
        FAIL += 1
    text = str(detail) if detail else ""
    print(f"  [{status}] {name}{(' — ' + text) if text else ''}")


def main() -> None:
    parser = argparse.ArgumentParser(description="NA 长期记忆自测")
    parser.add_argument("--real-llm", action="store_true", help="抽取用真实 API（默认 FakeLLM）")
    parser.add_argument("--data-dir", default=None, help="数据根目录（默认临时目录，结束清理）")
    parser.add_argument("--keep", action="store_true", help="保留临时数据目录（便于人工检查）")
    args = parser.parse_args()

    tmp = Path(args.data_dir) if args.data_dir else Path(tempfile.mkdtemp(prefix="na-memory-test-"))
    print("=" * 72)
    print("NA 长期记忆自测")
    print(f"  数据目录: {tmp}")

    mem_cfg = MemoryConfig(data_dir=tmp)
    ctx_cfg = SidecarConfig(data_dir=tmp)
    print(f"  模型: {mem_cfg.embed_model} → {mem_cfg.embed_dims} 维 | 精排: {mem_cfg.rerank_model}")
    print(f"  qdrant: {mem_cfg.qdrant_path} | history: {mem_cfg.history_db_path}")
    print("=" * 72)

    # ---------- 1. store 增/查/并/删（需 mem0 + 模型；缺失则跳过） ----------
    print("\n[1] MemoryStore 增/查/并/删")
    store = MemoryStore(mem_cfg, ctx_cfg)
    if store.available():
        r1 = store.add("用户偏好：要求简洁中文回复", category="preference", importance=3,
                       source_conversation_id="conv-test-a", source_seq=1)
        check("add 首次 → ADD", bool(r1 and r1.get("event") == "ADD"), str(r1))
        mem_id = r1.get("id") if r1 else None
        check("add 返回 id", bool(mem_id))

        r2 = store.add("用户偏好：要求简洁中文回复", category="preference", importance=4,
                       source_conversation_id="conv-test-a", source_seq=2)
        check("重复 add → 去重合并 UPDATE", bool(r2 and r2.get("event") == "UPDATE"),
              f"{r2}（重要性应取 max=4）")

        hits = store.search("回复简洁一点", top_k=5)
        check("search 命中", len(hits) >= 1, f"{len(hits)} 条")
        check("search 带 rerank_score", all("rerank_score" in h for h in hits),
              [round(h.get("rerank_score"), 3) for h in hits[:3]])

        all_ = store.list_all(limit=10)
        check("list_all 非空", len(all_) >= 1, f"{len(all_)} 条")
        merged = [r for r in all_ if r.get("metadata", {}).get("importance") == 4]
        check("合并后 importance=4", bool(merged), "去重合并已把重要性抬到 max")

        # 检索融合
        retriever = MemoryRetriever(store, mem_cfg)
        ranked = retriever.retrieve("用户想要简洁的回复风格", top_k=4)
        check("retrieve 融合排序", len(ranked) >= 1, f"{len(ranked)} 条 final={[round(h.final_score, 3) for h in ranked]}")
        if ranked:
            block = retriever.format_blocks(ranked[:1])[0]
            check("format_blocks 含类别与来源", "偏好" in block and "来源 conv-" in block, block)

        before = len(store.list_all(limit=100))
        deleted = store.delete(mem_id) if mem_id else False
        after = len(store.list_all(limit=100))
        check("delete 成功", bool(deleted), f"before={before} after={after}")
        check("delete 后计数减一", after == before - 1, f"{before} → {after}")
        check("删除不存在的 id → False", store.delete("no-such-id") is False)

        check("qdrant 落盘", mem_cfg.qdrant_path.exists(), str(mem_cfg.qdrant_path))
        check("history.db 落盘", mem_cfg.history_db_path.exists(), str(mem_cfg.history_db_path))
    else:
        print(f"  [SKIP] mem0/模型不可用：{store.last_error or '未知原因'}")

    # ---------- 2. 抽取（纯逻辑，无需 mem0） ----------
    print("\n[2] MemoryExtractor 抽取（FakeLLM）")
    llm = FakeLLMClient() if not args.real_llm else None
    if args.real_llm:
        try:
            from sidecar.services.context.llm import DeepSeekClient
            llm = DeepSeekClient(ctx_cfg)
        except Exception as e:
            print(f"  [SKIP] 真实 LLM 不可用：{e}")
            llm = None
    extractor = MemoryExtractor(llm)
    payload = {
        "user": {"text": "以后回复都简洁一点，用中文。", "constraints": "简洁、中文", "intent": "设置回复风格偏好"},
        "assistant": {"conclusion": "好的，以后简洁中文回复。", "support": "已确认用户偏好"},
        "tool_calls": [],
    }
    drafts = extractor.extract_from_dismantled_turn(payload)
    check("FakeLLM 抽取出记忆", len(drafts) >= 1, f"{len(drafts)} 条")
    if drafts:
        d = drafts[0]
        check("抽取类别=preference", d.category == "preference", d.category)
        check("抽取 importance∈1..5", 1 <= d.importance <= 5, str(d.importance))
        check("抽取文本非空", bool(d.text.strip()), d.text[:40])
    transcript = extractor.build_transcript(payload)
    check("build_transcript 含用户与模型内容",
          "用户说" in transcript and "模型结论" in transcript and "简洁" in transcript)

    # ---------- 3. MemoryService 集成（异步沉降） ----------
    print("\n[3] MemoryService 异步沉降 + 注入回调")
    storage = ConversationStorage(tmp / "conversations")
    # 复用 §1 的 store：qdrant 本地同一 path 只允许一个 client，否则二次打开报 "already accessed"
    svc = MemoryService(ctx_cfg, mem_cfg, storage, llm=llm, store=store)
    svc.start()
    # 预热线程与 store 结果一致（mem0 已在 §1 初始化）；此处同步置位避免竞态
    svc._ready = store.available()

    if store.available():
        from sidecar.services.context.types import AssistantDismantled, UserDismantled  # noqa: E402

        check("enabled=True（cfg 开启 + ready）", svc.enabled is True)

        # 构造一轮拆卸数据并触发沉降
        storage.build_dismantled_payload(
            "conv-mem-a", seq=1,
            user=UserDismantled(constraints="标题三级、列表无序、不用表格",
                                intent="记录用户整理偏好"),
            assistant=AssistantDismantled(conclusion="已记住整理偏好。", support=None),
            tool_calls=None,
        )
        svc.enqueue_extraction("conv-mem-a", 1)
        check("入队成功（enabled 时非阻塞入队）", True)

        # 注入回调：直接构造一条已知记忆，验证 provide_memory_blocks 路径
        store.add("用户整理偏好：标题用三级标题，列表用无序列表，不要表格",
                  category="preference", importance=4,
                  source_conversation_id="conv-mem-a", source_seq=1)
        blocks = svc.provide_memory_blocks("帮我整理笔记，我平时喜欢怎么排？")
        check("provide_memory_blocks 命中", blocks is not None and len(blocks) >= 1,
              f"{len(blocks) if blocks else 0} 块" + (f"：{blocks[0][:60]}" if blocks else ""))

        # 等 worker 消费完（队列可能仍在处理抽取）
        import time as _time
        _time.sleep(1.5)
        memories = svc.list_memories(limit=20)
        check("list_memories 非空", len(memories) >= 1, f"{len(memories)} 条")
        if memories:
            check("list_memories 字段完整",
                  all(k in memories[0] for k in ("id", "text", "category", "importance", "created_at")),
                  str(memories[0].get("category")))
    else:
        # 无 mem0：仅验证 enqueue 空转不报错、shutdown 干净
        svc.enqueue_extraction("conv-mem-a", 1)
        check("无 mem0 时 enqueue 空转不报错", True)

    svc.shutdown()

    # ---------- 汇总 ----------
    print("\n" + "=" * 72)
    if FAIL:
        print(f"结果：{FAIL} 项 FAIL（其余通过）")
        sys.exit(1)
    print("结果：全部 PASS")
    if not args.keep and not args.data_dir:
        shutil.rmtree(tmp, ignore_errors=True)
        print(f"（临时目录已清理：{tmp}）")
    elif args.data_dir:
        print(f"（数据保留于：{tmp}）")


if __name__ == "__main__":
    main()
