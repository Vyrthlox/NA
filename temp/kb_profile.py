"""知识库检索管线逐段计时：找出慢在哪。用法：PYTHONIOENCODING=utf-8 python temp/kb_profile.py"""
import sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sidecar.services.context.config import SidecarConfig
from sidecar.services.knowledge.config import KnowledgeConfig
from sidecar.services.knowledge.service import KnowledgeService
from sidecar.services.knowledge.tokenizer import tokenize

cfgs = SidecarConfig.load() if hasattr(SidecarConfig, "load") else SidecarConfig()
kn = KnowledgeConfig()
svc = KnowledgeService(cfgs, kn)
svc._ensure_indexed()
print(f"index: docs={len(svc.store.doc_meta)} chunks={len(svc.store.chunks)} type={svc.vector.index_type}")

def t(label, fn):
    t0 = time.perf_counter()
    r = fn()
    dt = (time.perf_counter() - t0) * 1000
    print(f"  {label:28s} {dt:8.1f} ms")
    return r

QUERIES = [
    "RAG 检索是怎么做的？",
    "「高精度重排」模型怎么做",
    "IndexFlatIP",
    "知识库有哪些功能",
]

# 预热模型加载（首查会触发懒加载）
t("warmup light reranker", lambda: svc.reranker.light_available())

for q in QUERIES:
    print(f"\nquery: {q}")
    q = q.strip()
    with svc._lock:
        chunks = list(svc.store.chunks)
        vectors = svc.store.vectors
        position_of = dict(svc.store.position_of)

    qt = t("tokenize", lambda: tokenize(q))
    bm25_hits = t("bm25 search", lambda: svc.bm25.search(qt, top_k=kn.bm25_top_k))
    exact_tokens = svc._exact_query_tokens(q)
    if exact_tokens:
        t("bm25 exact", lambda: svc.bm25.search(exact_tokens, top_k=kn.bm25_top_k, exact=True))
    if vectors is not None and svc.embedder.available():
        qv = t("embed_query", lambda: svc.embedder.embed_query(q))
        t("vector search", lambda: svc.vector.search(qv, top_k=kn.vector_top_k))
    from sidecar.services.knowledge.rrf import dedupe
    fused = t("rrf+dedupe", lambda: dedupe([bm25_hits], kn, position_of, vectors))
    cands = fused[: kn.rrf_candidates]
    cand_chunks = [chunks[position_of[cid]] for cid, _ in cands]
    print(f"  candidates={len(cand_chunks)}")
    t("cascade rerank", lambda: svc.reranker.rerank(q, cand_chunks, final_top=kn.final_top))

print("\n完整 search() 总耗时:")
for q in QUERIES:
    t0 = time.perf_counter()
    svc.search(q)
    print(f"  {q:30s} {(time.perf_counter()-t0)*1000:8.1f} ms")
