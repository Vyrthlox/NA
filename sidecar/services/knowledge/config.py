"""RAG 知识库配置（环境变量 `KN_*` 可覆盖，不写死任何 key）。

与 MemoryConfig 同源模式：从 temp/.env 加载，模型缓存复用 data/memory/models
（bge-small-zh 记忆模块已缓存，避免重复下载），HF 端点默认 hf-mirror.com。
默认值与用户给定的检索规格一致（BM25 三套参数 / FAISS 规模分档 / 切分窗口）。
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

# sidecar/services/knowledge/config.py 向上 4 级 = 仓库根目录
REPO_ROOT = Path(__file__).resolve().parents[3]


def _env_bool(name: str, default: str) -> bool:
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")


class KnowledgeConfig:
    """RAG 知识库引擎的全部配置。"""

    def __init__(
        self,
        *,
        data_dir: Path | str | None = None,
        env_file: Path | str | None = None,
        kb_id: str | None = None,
    ) -> None:
        env_path = Path(env_file) if env_file is not None else Path(
            os.environ.get("NA_ENV_FILE", REPO_ROOT / "temp" / ".env")
        )
        if env_path.exists():
            load_dotenv(env_path)

        # --- 开关与模型 ---
        self.enabled = _env_bool("KNOWLEDGE_ENABLED", "1")
        self.embed_model = os.environ.get("KN_EMBED_MODEL", "BAAI/bge-small-zh-v1.5")
        self.embed_dims = int(os.environ.get("KN_EMBED_DIMS", "512"))
        # 级联重排：轻量先选 top10，高精度再筛 topN
        self.rerank_light_model = os.environ.get("KN_RERANK_LIGHT_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2")
        self.rerank_heavy_model = os.environ.get("KN_RERANK_HEAVY_MODEL", "BAAI/bge-reranker-v2-m3")

        # --- 文档切分（tokens）---
        self.chunk_min_tokens = int(os.environ.get("KN_CHUNK_MIN", "256"))
        self.chunk_max_tokens = int(os.environ.get("KN_CHUNK_MAX", "512"))
        self.chunk_overlap_tokens = int(os.environ.get("KN_CHUNK_OVERLAP", "50"))
        # 语义校验切分：并入下一块前，当前累积文本与新块 embedding 余弦低于该值即强制切
        self.sem_threshold = float(os.environ.get("KN_SEM_THRESHOLD", "0.5"))
        # 短/长文档 BM25 参数切换阈值（chunk token 数）
        self.short_doc_threshold = int(os.environ.get("KN_SHORT_DOC_THRESHOLD", "300"))

        # --- BM25 三套参数 ---
        self.bm25_short = {"k1": float(os.environ.get("KN_BM25_SHORT_K1", "1.2")),
                           "b": float(os.environ.get("KN_BM25_SHORT_B", "0.5"))}
        self.bm25_long = {"k1": float(os.environ.get("KN_BM25_LONG_K1", "1.5")),
                          "b": float(os.environ.get("KN_BM25_LONG_B", "0.8"))}
        self.bm25_exact = {"k1": float(os.environ.get("KN_BM25_EXACT_K1", "0.0")),
                           "b": float(os.environ.get("KN_BM25_EXACT_B", "0.75"))}

        # --- 召回 ---
        self.bm25_top_k = int(os.environ.get("KN_BM25_TOP_K", "50"))       # BM25 Top-K
        self.vector_top_k = int(os.environ.get("KN_VECTOR_TOP_K", "50"))   # FAISS Top-k
        self.rrf_k = int(os.environ.get("KN_RRF_K", "60"))                 # RRF 常数（标准值 60）
        # 融合后送入重排的候选上限：级联只保留 light_top=10，喂 15+ 纯浪费（第 11 名后的分用不上）
        self.rrf_candidates = int(os.environ.get("KN_RRF_CANDIDATES", "15"))

        # --- 重排 ---
        self.rerank_light_top = int(os.environ.get("KN_RERANK_LIGHT_TOP", "10"))  # 轻量模型选出前 N
        self.final_top = int(os.environ.get("KN_FINAL_TOP", "3"))                 # 高精度模型最终 Top-N
        self.final_top_max = int(os.environ.get("KN_FINAL_TOP_MAX", "5"))         # Top-N 允许范围上界
        # 高精度重排默认关闭：本机 CPU 逐查询加载 2.2G bge-reranker-v2-m3 不可行（首查卡 ~12.5s、每次 10 对 ≈ 15-20s）。
        # 关闭后即现状实际行为（加载失败→回退轻量），只是不再白等。--heavy 自测显式开启（KN_RERANK_HEAVY=1）。
        self.rerank_heavy_enabled = _env_bool("KN_RERANK_HEAVY", "0")
        # 送入重排器的文本 token 上限（仅用于打分，展示仍全文）：控制 MiniLM 成本，库变大/chunk 变长后兜底
        self.rerank_max_tokens = int(os.environ.get("KN_RERANK_MAX_TOKENS", "128"))

        # --- 去重 ---
        self.cosine_dup_threshold = float(os.environ.get("KN_DUP_COSINE", "0.92"))  # 相似度去重阈值

        # --- FAISS 规模分档（索引自选）---
        self.flat_threshold = int(os.environ.get("KN_FAISS_FLAT_MAX", "100_000"))      # <100k → IndexFlatIP
        self.ivf_threshold = int(os.environ.get("KN_FAISS_IVF_MAX", "1_000_000"))      # 100k~1M → IVF+Flat
        self.ivf_nlist_factor = float(os.environ.get("KN_FAISS_NLIST_FACTOR", "4.0"))  # nlist = factor·√N
        self.ivf_nprobe = int(os.environ.get("KN_FAISS_NPROBE", "16"))
        self.pq_m = int(os.environ.get("KN_FAISS_PQ_M", "16"))  # >1M → IVF+PQ 的 m

        # --- 生成 ---
        self.gen_max_chars = int(os.environ.get("KN_GEN_MAX_CHARS", "16000"))  # 注入上下文字符上限

        # --- 数据与模型缓存目录 ---
        base = Path(data_dir) if data_dir is not None else Path(
            os.environ.get("NA_DATA_DIR", REPO_ROOT / "data")
        )
        # kb_id 时构造 per-KB 配置：data_dir = base/knowledge/<kb_id>（独立索引目录）
        self.kb_id = kb_id
        if kb_id:
            self.data_dir = base / "knowledge" / kb_id
        else:
            self.data_dir = base / "knowledge"
        # 模型缓存默认复用记忆模块目录（bge-small-zh 已缓存），KN_MODEL_CACHE_DIR 可另指
        self.models_cache_dir = Path(os.environ.get("KN_MODEL_CACHE_DIR", base / "memory" / "models"))

        # 与 MemoryConfig 一致：缓存与下载端点须在模型导入前生效（setdefault，先到者胜）
        os.environ.setdefault("HF_HOME", str(self.models_cache_dir))
        os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

    @property
    def chunks_path(self) -> Path:
        """chunk 清单（每行一个 Chunk.to_dict()）：data/knowledge/chunks.jsonl"""
        return self.data_dir / "chunks.jsonl"

    @property
    def index_meta_path(self) -> Path:
        """文档清单（mtime/size → 增量 reindex）：data/knowledge/index_meta.json"""
        return self.data_dir / "index_meta.json"

    @property
    def faiss_path(self) -> Path:
        """FAISS 索引落盘：data/knowledge/faiss.index"""
        return self.data_dir / "faiss.index"

    @property
    def library_dir(self) -> Path:
        """索引源目录：全局 = data/library/（旧自动索引语义）；per-KB = files/（用户上传文件）。"""
        if self.kb_id:
            return self.data_dir / "files"
        return self.data_dir.parent / "library"

    @property
    def files_dir(self) -> Path:
        """per-KB 上传文件目录（仅 kb_id 时使用）：data/knowledge/<kb_id>/files/"""
        return self.data_dir / "files"

    def validate(self) -> None:
        """参数合法性收拢：窗口/阈值兜底，避免配置错误导致运行时异常。"""
        if not (self.chunk_min_tokens < self.chunk_max_tokens):
            self.chunk_min_tokens, self.chunk_max_tokens = 256, 512
        if not (0 < self.rrf_k):
            self.rrf_k = 60
        self.final_top = max(1, min(self.final_top, self.final_top_max))
