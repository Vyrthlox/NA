"""上下文管理器（核心）。

职责：
1. 分级保留 —— 近期(0~N)全量 / 中期(N~M)压缩 / 远期(M+)事实锚点；
   轮次推移时惰性触发压缩与锚点提取，避免每轮都做无谓的 LLM 调用。
2. 上下文组装 —— 把系统提示词 + 远期锚点 + 中期压缩 + 近期全量拼成消息链。
3. 每轮编排 —— 拆卸用户输入 → 组装上下文 → 调 LLM → 拆卸回复/工具 →
   落盘拆卸产物到 dismantled.json → 更新分级 → 落盘 context.json。

对外流程：
    cm.prepare_turn(user_text)        # 拆卸用户输入，返回 (messages, user_dismantled)
    assistant_text = llm.stream_chat(...)  # 或 chat(...)
    cm.finalize_turn(user_text, assistant_text, user_dismantled, tool_calls=...)
便捷方法 run_turn(...) 把以上串成一步。
"""

from __future__ import annotations

import datetime
from typing import Any, Callable

from .config import SidecarConfig
from .dismantler import Dismantler
from .llm import LLMClient, DeepSeekClient, LLMRouter
from .reducer import Reducer, render_tool_for_context
from .storage import ConversationStorage
from .thresholds import ThresholdPolicy
from .types import Turn, ToolReduced, UserDismantled


def _now() -> str:
    return datetime.datetime.now().isoformat(timespec="seconds")


class ContextManager:
    def __init__(
        self,
        config: SidecarConfig,
        *,
        llm: LLMClient | None = None,
        dismantler: Dismantler | None = None,
        reducer: Reducer | None = None,
        storage: ConversationStorage | None = None,
        policy: ThresholdPolicy | None = None,
        memory_provider: Callable[[str], list[str] | None] | None = None,
    ) -> None:
        self.config = config
        # self.llm：内部上下文操作（拆卸/缩减/锚点/记忆）的默认客户端 = DeepSeek fast，
        # 不随用户模型选择变化；主回复按 (provider, depth) 走 llm_for 路由。
        self.llm = llm or DeepSeekClient(config)
        self._router = LLMRouter(config)
        self.memory_provider = memory_provider
        self.dismantler = dismantler or Dismantler(self.llm)
        self.reducer = reducer or Reducer(self.llm)
        self.storage = storage or ConversationStorage(config.conversations_dir)
        self.policy = policy or ThresholdPolicy(config)
        self.system_prompt = self._load_system_prompt()
        self.conversation_id: str | None = None
        self.turns: list[Turn] = []

    # ---------------- 生命周期 ----------------

    def _load_system_prompt(self) -> str:
        path = self.config.system_prompt_path
        if path.exists():
            return path.read_text(encoding="utf-8").strip()
        return "你是 NA，一个智能笔记助手。"

    def create_conversation(self, conversation_id: str | None = None) -> str:
        if conversation_id is None:
            conversation_id = "conv-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        self.conversation_id = conversation_id
        self.turns = []
        self._persist()
        return conversation_id

    def load_conversation(self, conversation_id: str) -> None:
        data = self.storage.load_context(conversation_id)
        if data is None:
            raise FileNotFoundError(f"对话不存在：{conversation_id}")
        self.conversation_id = conversation_id
        self.turns = [Turn.from_dict(t) for t in data.get("turns", [])]
        stored_n, stored_m = data.get("n"), data.get("m")
        if stored_n:
            self.policy.n = int(stored_n)
        if stored_m:
            self.policy.m = int(stored_m)

    def _persist(self) -> None:
        if not self.conversation_id:
            return
        n, m = self.policy.current
        self.storage.save_context(
            self.conversation_id,
            {
                "conversation_id": self.conversation_id,
                "n": n,
                "m": m,
                "updated_at": _now(),
                "turns": [t.to_dict() for t in self.turns],
            },
        )

    # ---------------- 分级阈值 ----------------

    @property
    def n(self) -> int:
        return self.policy.n

    @property
    def m(self) -> int:
        return self.policy.m

    def finish_conversation(self) -> None:
        """对话结束：记录轮数，供后续按平均轮数动态调整 N/M。"""
        self.policy.record_conversation_length(len(self.turns))
        self._persist()

    def llm_for(self, provider: str, depth: str) -> LLMClient:
        """按 (provider, depth) 解析主回复用的 LLM 客户端（LLMRouter 缓存）。

        provider 未配置或模型缺失时抛 KeyError，由调用方转成清晰错误。
        """
        return self._router.get(provider, depth)

    # ---------------- 上下文组装 ----------------

    def assemble_messages(
        self,
        pending_user_text: str | None = None,
        *,
        attachment_context: str | None = None,
        image_parts: list[dict] | None = None,
    ) -> list[dict[str, Any]]:
        """组装发送给 LLM 的消息链。时间顺序：系统提示 → 远期锚点 → 中期压缩 → 近期全量 → 本轮输入。

        attachment_context：本轮附带文件的文本块（attachment_reader 组装），
        非空时拼在本轮用户消息之前，让 LLM 把文件内容与提问当作同一轮理解。
        image_parts：本轮附带图片的 OpenAI 兼容 content-parts（image_url，base64 data URL）。
        非空时本轮用户消息的 content 变为 parts 数组（文本 part + 图片 parts），
        历史轮次保持纯字符串。空则维持纯字符串（与旧行为一致）。
        """
        messages: list[dict[str, Any]] = [{"role": "system", "content": self.system_prompt}]

        # 远期：事实锚点合并为一个 system 块（作为既定事实放在最前）
        anchors = [a for t in self.turns if t.tier == "anchored" for a in t.fact_anchors]
        if anchors:
            messages.append(
                {
                    "role": "system",
                    "content": "历史已确认的事实锚点（用户偏好、已确认事实、长期约定）：\n"
                    + "\n".join(f"- {a}" for a in anchors),
                }
            )

        # 长期记忆（跨会话已确认要点）：锚点块之后追加，检索失败绝不阻断对话
        if pending_user_text and self.memory_provider:
            try:
                blocks = self.memory_provider(pending_user_text)
            except Exception:
                blocks = None
            if blocks:
                messages.append(
                    {
                        "role": "system",
                        "content": "长期记忆（跨会话已确认要点）：\n" + "\n".join(f"- {b}" for b in blocks),
                    }
                )

        for t in self.turns:
            # 知识库问答 / 文档整理轮次仅落盘历史展示，不进入普通对话上下文（纯辅助操作语义）
            if t.kind in ("kb", "organize"):
                continue
            if t.tier == "compressed":
                if t.user_intent_summary or t.constraints or t.tool_reduced:
                    messages.append({"role": "user", "content": self._render_compressed_user(t)})
                if t.key_conclusions or t.tool_reduced:
                    messages.append({"role": "assistant", "content": self._render_compressed_assistant(t)})
            elif t.tier == "recent":
                self._append_recent_turn(messages, t)

        if pending_user_text:
            text = pending_user_text
            if attachment_context:
                text = f"{attachment_context}\n\n{text}"
            if image_parts:
                # 多模态：文本 part 在前、图片 parts 在后；image_url 只能出现在 user 消息
                messages.append({"role": "user", "content": [{"type": "text", "text": text}, *image_parts]})
            else:
                messages.append({"role": "user", "content": text})
        return messages

    @staticmethod
    def _render_compressed_user(t: Turn) -> str:
        parts = [f"[历史对话·用户] 意图摘要：{t.user_intent_summary or '—'}"]
        if t.constraints:
            parts.append(f"约束：{t.constraints}")
        for frag in t.user_key_fragments:
            parts.append(f"关键片段：{frag}")
        for tc in t.tool_reduced:
            parts.append(render_tool_for_context(tc))
        return "\n".join(parts)

    @staticmethod
    def _render_compressed_assistant(t: Turn) -> str:
        lines = ["[历史对话·AI] 关键结论："]
        lines += [f"- {c}" for c in (t.key_conclusions or ["—"])]
        for tc in t.tool_reduced:
            lines.append(render_tool_for_context(tc))
        return "\n".join(lines)

    @staticmethod
    def _append_recent_turn(messages: list[dict[str, str]], t: Turn) -> None:
        """近期轮：全量原文；工具调用按缩减策略（参数+结果摘要）附加为 user 块。"""
        if t.user_text:
            messages.append({"role": "user", "content": t.user_text})
        if t.assistant_text:
            messages.append({"role": "assistant", "content": t.assistant_text})
        for tc in t.tool_reduced:
            messages.append({"role": "user", "content": render_tool_for_context(tc)})

    # ---------------- 每轮编排 ----------------

    def prepare_turn(
        self,
        user_text: str,
        *,
        attachment_context: str | None = None,
        image_parts: list[dict] | None = None,
    ) -> tuple[list[dict[str, Any]], UserDismantled]:
        """轮次前置：拆卸用户输入（产物落盘由 finalize 统一处理），返回 (消息链, 拆卸结果)。

        attachment_context：本轮附带文件文本块，透传给 assemble_messages 拼入用户消息。
        image_parts：本轮附带图片 content-parts，透传 assemble_messages（有图才多模态）。
        """
        if not self.conversation_id:
            self.create_conversation()
        user_dismantled = self.dismantler.user_input(user_text)
        messages = self.assemble_messages(
            pending_user_text=user_text, attachment_context=attachment_context, image_parts=image_parts
        )
        return messages, user_dismantled

    def finalize_turn(
        self,
        user_text: str,
        assistant_text: str,
        user_dismantled: UserDismantled,
        *,
        tool_calls: list[dict[str, Any]] | None = None,
    ) -> Turn:
        """轮次收尾：拆卸回复/工具 → 落盘拆卸产物 → 建 Turn → 分级更新 → 落盘上下文。"""
        assistant_dismantled = self.dismantler.assistant_reply(assistant_text)
        tool_dismantled = [
            self.dismantler.tool_call(
                tc["name"], tc.get("args", {}), tc.get("result", "")
            )
            for tc in (tool_calls or [])
        ]
        seq = self._next_seq()
        self.storage.build_dismantled_payload(
            self.conversation_id,
            seq=seq,
            user=user_dismantled,
            assistant=assistant_dismantled,
            tool_calls=tool_dismantled,
        )
        turn = Turn(
            seq=seq,
            user_text=user_text,
            assistant_text=assistant_text,
            user_intent_summary=user_dismantled.intent,  # 拆卸产出的意图摘要，压缩阶段直接复用
            constraints=user_dismantled.constraints,
            tool_reduced=[
                ToolReduced(name=td.name, args=td.args, result_summary=td.result_summary)
                for td in tool_dismantled
            ],
        )
        self.turns.append(turn)
        self._recompute_tiers()
        self._persist()
        return turn

    def finalize_kb_turn(
        self,
        user_text: str,
        assistant_text: str,
        citations: list[dict[str, Any]] | None = None,
    ) -> Turn:
        """知识库问答轮次落盘：仅写入 context.json 供历史会话展示/恢复。

        与 finalize_turn 的区别：不做拆卸（dismantled.json）、不参与分级压缩/锚点提取、
        不进入上下文组装（assemble_messages 跳过 kind=kb）——保持「纯知识库问答不掺普通
        聊天上下文」的语义。seq 与普通轮次共用递增，历史列表按序展示。
        """
        if not self.conversation_id:
            self.create_conversation()
        turn = Turn(
            seq=self._next_seq(),
            kind="kb",
            tier="recent",
            user_text=user_text,
            assistant_text=assistant_text,
            citations=list(citations or []),
        )
        self.turns.append(turn)
        self._persist()
        return turn

    def finalize_organize_turn(
        self,
        user_text: str,
        assistant_text: str,
    ) -> Turn:
        """文档整理轮次落盘：仅写入 context.json 供历史会话展示/恢复。

        与 finalize_kb_turn 语义一致：不做拆卸（整理出的文档正文可能很长，
        避免对整篇文档再触发 LLM 摘要）、不参与分级压缩/锚点提取、
        不进入上下文组装（避免把整篇文档重新注入后续对话）。
        """
        if not self.conversation_id:
            self.create_conversation()
        turn = Turn(
            seq=self._next_seq(),
            kind="organize",
            tier="recent",
            user_text=user_text,
            assistant_text=assistant_text,
        )
        self.turns.append(turn)
        self._persist()
        return turn

    def run_turn(
        self,
        user_text: str,
        *,
        tool_calls: list[dict[str, Any]] | None = None,
    ) -> str:
        """一步完成一轮对话（非流式），返回模型回复文本。"""
        messages, user_dismantled = self.prepare_turn(user_text)
        assistant_text = self.llm.chat(messages)
        self.finalize_turn(user_text, assistant_text, user_dismantled, tool_calls=tool_calls)
        return assistant_text

    def _next_seq(self) -> int:
        return (self.turns[-1].seq + 1) if self.turns else 1

    # ---------------- 分级更新 ----------------

    def _recompute_tiers(self) -> None:
        """按当前轮数重算每轮的层级（只升不降），必要时惰性触发压缩 / 锚点提取。"""
        total = len(self.turns)
        for i, t in enumerate(self.turns):
            # 知识库问答 / 文档整理轮次保持 recent、不做压缩/锚点（不进上下文，无需分级）
            if t.kind in ("kb", "organize"):
                continue
            behind = total - i  # 距最新轮的距离
            if behind > self.m:
                target = "anchored"
            elif behind > self.n:
                target = "compressed"
            else:
                target = "recent"
            if t.tier == target:
                continue
            if target == "compressed":
                self._compress(t)
            elif target == "anchored":
                self._anchor(t)
            t.tier = target

    def _compress(self, t: Turn) -> None:
        """中期压缩：保留用户意图摘要（ingest 时拆卸已产出）+ 关键结论，丢弃中间推理（全文）。
        用户输入的「意图提取+关键片段」缩减仅在文本较长时触发，避免不必要的 LLM 调用。
        """
        if t.user_text and len(t.user_text) > self.config.long_text_chars:
            red = self.reducer.user_input(t.user_text)
            t.user_key_fragments = red.get("key_fragments", [])
        if t.assistant_text:
            red = self.reducer.assistant_reply(t.assistant_text)
            t.key_conclusions = red.get("key_arguments", [])
        t.user_text = None
        t.assistant_text = None

    def _anchor(self, t: Turn) -> None:
        """远期：仅保留事实锚点（用户偏好 / 已确认事实），其余保留内容全部丢弃。"""
        anchors = self.reducer.extract_anchors(self._retained_text(t))
        t.fact_anchors = anchors
        t.user_text = None
        t.assistant_text = None
        t.user_intent_summary = None
        t.user_key_fragments = []
        t.constraints = None
        t.key_conclusions = []
        t.tool_reduced = []

    def _retained_text(self, t: Turn) -> str:
        """当前保留内容的纯文本（供锚点提取作为素材）。"""
        parts: list[str] = []
        if t.user_text:
            parts.append("用户：" + t.user_text)
        if t.assistant_text:
            parts.append("AI：" + t.assistant_text)
        if t.user_intent_summary:
            parts.append("用户意图摘要：" + t.user_intent_summary)
        if t.constraints:
            parts.append("用户约束：" + t.constraints)
        for frag in t.user_key_fragments:
            parts.append("关键片段：" + frag)
        if t.key_conclusions:
            parts.append("关键结论：" + "；".join(t.key_conclusions))
        for tc in t.tool_reduced:
            parts.append(render_tool_for_context(tc))
        return "\n".join(parts) or "（无保留内容）"

    # ---------------- 观察辅助 ----------------

    def tier_counts(self) -> dict[str, int]:
        counts = {"recent": 0, "compressed": 0, "anchored": 0}
        for t in self.turns:
            counts[t.tier] = counts.get(t.tier, 0) + 1
        return counts

    def summarize(self) -> list[dict[str, Any]]:
        """每轮摘要（用于自测 / 日志）。"""
        out = []
        for t in self.turns:
            item: dict[str, Any] = {"seq": t.seq, "tier": t.tier}
            if t.user_text:
                item["user"] = t.user_text[:40]
            if t.assistant_text:
                item["assistant"] = t.assistant_text[:40]
            if t.user_intent_summary:
                item["intent"] = t.user_intent_summary[:40]
            if t.key_conclusions:
                item["conclusions"] = t.key_conclusions
            if t.fact_anchors:
                item["anchors"] = t.fact_anchors
            out.append(item)
        return out
