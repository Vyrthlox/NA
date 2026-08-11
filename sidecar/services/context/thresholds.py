"""N / M 阈值策略。

初始值 N=8、M=16。后续根据「用户对话轮数的平均值」动态重赋值：
记录每段对话完成的轮数（threshold_stats.json），当样本足够时按平均轮数重算。

默认公式（可调，符合直觉的启发式）：
    avg      = 历史对话平均轮数
    N = clamp(round(avg * 0.4), min=4, max=12)
    M = clamp(round(avg * 0.8), min=N+4, max=24)
样本不足（< MIN_SAMPLES 段对话）时保持初始值，避免噪声抖动。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .config import SidecarConfig

DEFAULT_N = 8
DEFAULT_M = 16
MIN_SAMPLES = 3


class ThresholdPolicy:
    def __init__(self, config: SidecarConfig) -> None:
        self.config = config
        self.n = config.n_recent
        self.m = config.m_mid
        self._lengths: list[int] = self._load_lengths()

    def _load_lengths(self) -> list[int]:
        path = self.config.stats_path
        if not path.exists():
            return []
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return [int(x) for x in data.get("lengths", [])]
        except (json.JSONDecodeError, OSError, TypeError, ValueError):
            return []

    def _save_lengths(self) -> None:
        path = self.config.stats_path
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps({"lengths": self._lengths}, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)

    # ---------------- 对外接口 ----------------

    @property
    def current(self) -> tuple[int, int]:
        return (self.n, self.m)

    def record_conversation_length(self, rounds: int) -> None:
        """一段对话结束时记录其轮数。"""
        self._lengths.append(rounds)
        self._save_lengths()

    def recompute(self) -> tuple[int, int]:
        """按平均轮数重算 N/M；样本不足时保持初始值。返回当前 (n, m)。"""
        if len(self._lengths) < MIN_SAMPLES:
            self.n, self.m = DEFAULT_N, DEFAULT_M
            return self.current
        avg = sum(self._lengths) / len(self._lengths)
        n = max(4, min(12, round(avg * 0.4)))
        m = max(n + 4, min(24, round(avg * 0.8)))
        if not (m > n):
            m = n + 4
        self.n, self.m = n, m
        return self.current

    @staticmethod
    def formula(avg_rounds: float) -> tuple[int, int]:
        """静态重算公式（供演示 / 单测）。"""
        n = max(4, min(12, round(avg_rounds * 0.4)))
        m = max(n + 4, min(24, round(avg_rounds * 0.8)))
        if not (m > n):
            m = n + 4
        return (n, m)
