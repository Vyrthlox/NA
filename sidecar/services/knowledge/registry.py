"""用户知识库注册表：data/knowledge/kbs.json（[{id, name, created_at}]）。

每个知识库（KB）有独立索引目录 data/knowledge/<id>/，注册表只记录元数据。
写盘原子（tmp + rename），线程安全。缺失/损坏时自动回退空列表，不抛异常。
"""

from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class KbRegistry:
    """KB 注册表：list / create / delete。"""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._items: list[dict[str, Any]] = []
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                self._items = [r for r in data if isinstance(r, dict) and r.get("id")]
        except Exception:
            self._items = []

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps(self._items, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(r) for r in self._items]

    def create(self, name: str) -> dict[str, Any]:
        name = (name or "").strip()
        if not name:
            raise ValueError("知识库名称不能为空")
        with self._lock:
            record = {
                "id": uuid.uuid4().hex[:8],
                "name": name,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            self._items.append(record)
            self._save()
            return dict(record)

    def delete(self, kb_id: str) -> bool:
        with self._lock:
            before = len(self._items)
            self._items = [r for r in self._items if r.get("id") != kb_id]
            if len(self._items) == before:
                return False
            self._save()
            return True
