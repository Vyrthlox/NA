#!/usr/bin/env python3
"""上下文管理逻辑自测入口：脚本化多轮对话，验证分级保留 / 缩减 / 拆卸 / 逐对话 JSON 落盘。

用法（在仓库根目录执行）：
    python -m sidecar.scripts.self_test                    # 真实调用 temp/.env 中的测试 key
    python -m sidecar.scripts.self_test --dry-run           # 离线（FakeLLM），不联网
    python -m sidecar.scripts.self_test --rounds 8 --n 2 --m 4
        # 用小阈值快速观察 近期/中期压缩/远期锚点 全部分级（默认生产阈值 N=8/M=16）
    python -m sidecar.scripts.self_test --conversation-id demo-conv
        # 指定对话 id，便于复用上次落盘的数据
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

# 仓库根目录 = sidecar/scripts/self_test.py 向上 3 级
REPO_ROOT = Path(__file__).resolve().parents[2]

# Windows 控制台可能默认 GBK，统一以 UTF-8 输出，避免中文乱码
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

sys.path.insert(0, str(REPO_ROOT))

from sidecar.services.context.config import SidecarConfig  # noqa: E402
from sidecar.services.context.context_manager import ContextManager  # noqa: E402
from sidecar.services.context.llm import DeepSeekClient, FakeLLMClient  # noqa: E402
from sidecar.services.context.thresholds import MIN_SAMPLES, ThresholdPolicy  # noqa: E402


def build_turns(count: int) -> list[tuple[str, list[dict] | None]]:
    """脚本化对话内容（贴合 SystemPrompt.md 的文档助手能力），返回 [(text, tool_calls), ...]。"""
    topics: list[tuple[str, list[dict] | None]] = [
        (
            "帮我把这句话翻译成英文：会议将于下周一下午三点召开，请提前准备材料。",
            None,
        ),
        (
            "整理下面这段会议记录，要求简洁、条理清晰。原文：产品组本周完成了需求评审，"
            "确定了三个优先级最高的功能；技术组反馈部署流程需要优化；预算方面暂定 10 万。",
            None,
        ),
        # 第 3 轮：模拟一次工具调用，验证工具调用三层拆卸路径
        (
            "在笔记里搜索一下关于「部署优化」的讨论，然后结合它回答怎么优化部署流程。",
            [
                {
                    "name": "note_search",
                    "args": {"query": "部署优化", "top_k": 3},
                    "result": "命中 2 篇笔记：1)《部署流程痛点》结论是改用增量发布；"
                    "2)《CI 配置》提到当前全量构建耗时过长。",
                }
            ],
        ),
        (
            "帮我校对这段话的错别字：他们今天一早去了公司，准备开展新产品发布会的准备工作。",
            None,
        ),
        (
            "帮我设计一个个人知识库的分类体系，我有三类资料：读书笔记、技术笔记、会议记录。",
            None,
        ),
        (
            "请把之前的会议记录总结成三个要点，并给出下一步建议。",
            None,
        ),
        (
            "我平时的整理偏好是：标题用三级标题，列表用无序列表，不要表格。",
            None,
        ),
        (
            "帮我把下面这段长文做结构梳理：" + ("这是一段需要梳理结构的较长的演示文本，包含了背景介绍、问题分析、方案对比与结论展望。背景是团队需要提升协作效率，" * 12),
            None,
        ),
    ]
    out: list[tuple[str, list[dict] | None]] = []
    for i in range(count):
        out.append(topics[i % len(topics)])
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="NA 上下文管理逻辑自测")
    parser.add_argument("--dry-run", action="store_true", help="离线模式，使用 FakeLLM，不联网")
    parser.add_argument("--rounds", type=int, default=8, help="对话轮数（默认 8）")
    parser.add_argument("--n", type=int, default=None, help="近期轮阈值 N（默认取配置 8）")
    parser.add_argument("--m", type=int, default=None, help="中期轮阈值 M（默认取配置 16）")
    parser.add_argument("--conversation-id", default=None, help="对话 id（默认按时间生成）")
    parser.add_argument("--data-dir", default=None, help="数据根目录（默认仓库 data/）")
    parser.add_argument("--env-file", default=None, help=".env 路径（默认 temp/.env）")
    args = parser.parse_args()

    cfg = SidecarConfig(
        n_recent=args.n,
        m_mid=args.m,
        data_dir=Path(args.data_dir) if args.data_dir else None,
        env_file=args.env_file,
    )

    llm = FakeLLMClient() if args.dry_run else DeepSeekClient(cfg)
    cm = ContextManager(cfg, llm=llm)

    mode = "离线（FakeLLM）" if args.dry_run else "在线（真实 API）"
    print("=" * 72)
    print(f"NA 上下文管理自测  [{mode}]")
    print(f"  模型: {cfg.model} | 接口: {cfg.base_url} | 系统提示词: {cfg.system_prompt_path.name}")
    print(f"  阈值: N(近期)={cm.n}  M(中期)={cm.m}  长文本触发缩减: >{cfg.long_text_chars} 字符")
    print(f"  数据目录: {cfg.data_dir}")
    print("=" * 72)

    if not args.conversation_id:
        args.conversation_id = "selftest-" + time.strftime("%Y%m%d-%H%M%S")
    cm.create_conversation(args.conversation_id)

    topics = build_turns(args.rounds)
    total_rounds = len(topics)
    for i, (text, tool_calls) in enumerate(topics, start=1):
        print(f"\n----------- 第 {i}/{total_rounds} 轮 -----------")
        print(f"[用户] {text[:80]}{'…' if len(text) > 80 else ''}")
        if tool_calls:
            print(f"[模拟工具调用] {[t['name'] for t in tool_calls]}")

        messages, user_dismantled = cm.prepare_turn(text)
        tiers = cm.tier_counts()
        print(f"[分级] {tiers} | 组装消息 {len(messages)} 条")
        _print_context_preview(messages)

        assistant_text = llm.chat(messages)
        print(f"[AI回复] {assistant_text[:120]}{'…' if len(assistant_text) > 120 else ''}")

        cm.finalize_turn(text, assistant_text, user_dismantled, tool_calls=tool_calls)
        print("[落盘] context.json + dismantled.json 已更新")

    print("\n" + "=" * 72)
    print("最终分级分布：", cm.tier_counts())
    print("每轮保留内容摘要：")
    for row in cm.summarize():
        print("  ", row)

    ctx_path = cm.storage.context_path(args.conversation_id)
    dis_path = cm.storage.dismantled_path(args.conversation_id)
    print(f"\n落盘文件：\n  context.json    -> {ctx_path}\n  dismantled.json -> {dis_path}")

    # 展示一份拆卸产物样例（工具调用那轮）
    import json as _json
    if dis_path.exists():
        dis = _json.loads(dis_path.read_text(encoding="utf-8"))
        print("\n拆卸产物样例（含工具调用的那轮）：")
        for seq, payload in dis.get("turns", {}).items():
            if payload.get("tool_calls"):
                print(f"  seq {seq}: {_json.dumps(payload, ensure_ascii=False)}")
                break

    _demo_threshold(cfg)

    print("\n自测完成。用 --dry-run 可离线重跑；用 --n/--m/--rounds 可调整阈值观察分级。")
    print(f"（生产默认 N=8/M=16，若要看全部分级建议 --rounds 18 以上）")


def _print_context_preview(messages: list[dict]) -> None:
    """打印组装消息链的分层预览（不输出全文）。"""
    for m in messages:
        head = m["content"].splitlines()[0][:70]
        print(f"    [{m['role']:<9}] {head}")


def _demo_threshold(cfg: SidecarConfig) -> None:
    """演示 N/M 随平均对话轮数的动态调整。"""
    policy = ThresholdPolicy(cfg)
    print("\nN/M 动态调整机制（当前样本数", len(policy._lengths), "，不足", MIN_SAMPLES, "段时保持初始值）：")
    for avg in (10, 25, 40):
        n, m = ThresholdPolicy.formula(avg)
        print(f"  平均 {avg:>2} 轮 -> N={n}, M={m}")


if __name__ == "__main__":
    main()
