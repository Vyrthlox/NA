"""验证：知识库问答落盘历史会话（bug 修复回归）。

构造最小 Flask app（挂真实 routes，注入 FakeKnowledgeService），
走 test client 调 POST /knowledge/query → 检查 GET /conversations 与 /conversations/<id>。
用法：PYTHONIOENCODING=utf-8 python temp/verify_kb_history.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from flask import Flask  # noqa: E402

from sidecar.routes.conversations import bp as conversations_bp  # noqa: E402
from sidecar.routes.knowledge import bp as knowledge_bp  # noqa: E402
from sidecar.services.context.config import SidecarConfig  # noqa: E402


class FakeCfg:
    final_top = 3
    final_top_max = 5


class FakeKnowledgeService:
    """route 需要的接口子集：indexed + query 直接返回假答案/引用。"""

    indexed = True

    def __init__(self) -> None:
        self.cfg = FakeCfg()

    def query(self, query, *, kb_id=None, provider=None, depth=None, top_n=None):
        return {
            "answer": f"（Fake）关于「{query}」的回答。",
            "citations": [
                {"chunk_id": "doc.md::1", "doc_id": "doc.md", "section": "", "text": "片段", "score": 1.0, "rank": 1, "sources": ["bm25"]}
            ],
        }


def main() -> None:
    tmp = tempfile.mkdtemp(prefix="na-kb-history-")
    ctx_cfg = SidecarConfig(data_dir=Path(tmp))

    app = Flask(__name__)
    app.config["CTX_CFG"] = ctx_cfg
    app.config["CONVERSATIONS"] = {}
    app.config["KNOWLEDGE_SERVICE"] = FakeKnowledgeService()
    app.register_blueprint(knowledge_bp)
    app.register_blueprint(conversations_bp)

    c = app.test_client()

    cid = "conv-kb-test-001"

    # 1) 知识库问答（带 conversation_id）→ 应返回 conversation_id 且落盘
    r = c.post("/knowledge/query", json={"query": "RAG 是什么", "kb_id": None, "conversation_id": cid})
    assert r.status_code == 200, r.get_data(as_text=True)
    body = r.get_json()
    assert body["conversation_id"] == cid, body
    assert "RAG 是什么" in body["answer"]
    print("[1] /knowledge/query 返回 conversation_id:", body["conversation_id"])

    # 2) 历史列表应包含该会话
    r = c.get("/conversations")
    items = r.get_json()["conversations"]
    assert any(x["conversation_id"] == cid for x in items), items
    item = next(x for x in items if x["conversation_id"] == cid)
    assert item["title"] == "RAG 是什么", item  # 标题=首条用户消息
    assert item["turn_count"] == 1, item
    print("[2] /conversations 命中:", item)

    # 3) 会话详情应返回 user + assistant（assistant 带 citations）
    r = c.get(f"/conversations/{cid}")
    turns = r.get_json()["turns"]
    assert [t["role"] for t in turns] == ["user", "assistant"], turns
    assert turns[0]["text"] == "RAG 是什么"
    assert turns[1]["text"].startswith("（Fake）")
    assert turns[1]["citations"][0]["doc_id"] == "doc.md"
    print("[3] /conversations/<id> turns:", [(t["role"], t["text"][:16]) for t in turns])

    # 4) 同一会话第二问 → turn_count 递增、seq 连续
    c.post("/knowledge/query", json={"query": "再问一个", "conversation_id": cid})
    r = c.get("/conversations")
    item = next(x for x in r.get_json()["conversations"] if x["conversation_id"] == cid)
    assert item["turn_count"] == 2, item
    r = c.get(f"/conversations/{cid}")
    turns = r.get_json()["turns"]
    assert [t["role"] for t in turns] == ["user", "assistant", "user", "assistant"], turns
    assert [t["seq"] for t in turns] == [1, 1, 2, 2], turns
    print("[4] 同会话追加一轮 → turn_count=2, seq=[1,1,2,2]")

    # 5) 不带 conversation_id → 服务端新建并回传
    r = c.post("/knowledge/query", json={"query": "无 id 的一问"})
    body = r.get_json()
    assert body["conversation_id"], body
    r = c.get("/conversations")
    ids = [x["conversation_id"] for x in r.get_json()["conversations"]]
    assert body["conversation_id"] in ids
    print("[5] 无 conversation_id → 服务端新建:", body["conversation_id"])

    # 6) 普通对话（/chat 路径不受影响：KB 轮次不进上下文组装）
    #    这里直接验证 assemble_messages 跳过 kind=kb —— 用真实 ContextManager 组装
    from sidecar.registry import get_or_create_conversation

    cm, _ = get_or_create_conversation(app, cid)
    msgs = cm.assemble_messages()
    joined = "".join(m.get("content", "") for m in msgs if isinstance(m.get("content"), str))
    assert "RAG 是什么" not in joined, "KB 轮次不应进入普通对话上下文"
    assert "（Fake）" not in joined, "KB 回答不应进入普通对话上下文"
    print("[6] assemble_messages 不含 KB 轮次（纯知识库问答语义保留）")

    print("\nPASS: 知识库问答已落盘历史会话并可恢复（含 citations）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
