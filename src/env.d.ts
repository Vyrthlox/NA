/// <reference types="vite/client" />

type SidecarStatus = 'starting' | 'ready' | 'stopped' | 'crashed' | 'failed'

/** 模型提供商（deepseek 文本 / qwen 视觉），与 gateway 的 ProviderKey 一致 */
type ProviderKey = 'deepseek' | 'qwen'
/** DS 深度两档（快速/深度），与 gateway 的 DepthKey 一致 */
type DepthKey = 'fast' | 'deep'
/** 用户模型选择：提供商 × 深度档位 */
interface ModelChoice {
  provider: ProviderKey
  depth: DepthKey
}

/** 已上传附件（wire 字段 snake_case，与 sidecar 返回一致） */
interface Attachment {
  id: string
  name: string
  size: number
  mime: string
  stored_name: string
  uploaded_at: number
}

interface SidecarStatusInfo {
  status: SidecarStatus
  ready: boolean
  baseUrl: string | null
  attempts: number
}

/** 历史会话列表项（GET /conversations，wire 字段 snake_case 与 sidecar 一致） */
interface ConversationSummary {
  conversation_id: string
  title: string
  turn_count: number
  updated_at: string
  preview: string
}

/** 历史会话单轮消息（GET /conversations/<id> 的 turns 元素） */
interface ConversationTurn {
  seq: number
  role: 'user' | 'assistant'
  text: string
  /** 知识库问答轮次的引用来源（仅 assistant 且 kind=kb 时携带） */
  citations?: KnowledgeCitation[]
}

/** 与 electron/main/gateway/client.ts 的 ChatStreamEvent 一致 */
type SidecarChatEvent =
  | {
      conversationId: string
      type: 'meta'
      data: { conversation_id: string; n: number; m: number; provider?: ProviderKey; depth?: DepthKey | null; model?: string }
    }
  | { conversationId: string; type: 'chunk'; data: { content: string } }
  | {
      conversationId: string
      type: 'done'
      data: {
        conversation_id: string
        reply: string
        tier_counts: Record<string, number>
        context_path: string
        dismantled_path: string
      }
    }
  | { conversationId: string; type: 'error'; data: { error: string } }

/** 文件库节点：文件夹（可含 children）/ 文件。id 为相对 data/library/ 的 posix 路径 */
interface LibraryNode {
  id: string
  name: string
  type: 'folder' | 'file'
  children?: LibraryNode[]
}

/** 知识库检索结果片段（POST /knowledge/search 的 results 元素，wire 字段 snake_case 与 sidecar 一致） */
interface KnowledgeSearchResult {
  chunk_id: string
  doc_id: string
  text: string
  section: string
  score: number
  rank: number
  /** 命中来源：bm25 / vector / exact / rrf */
  sources: string[]
}

interface KnowledgeSearchResponse {
  query: string
  results: KnowledgeSearchResult[]
}

/** 知识库问答引用（POST /knowledge/query 的 citations 元素；text 截断到 2000 字符） */
interface KnowledgeCitation {
  chunk_id: string
  doc_id: string
  section: string
  text: string
  score: number
  rank: number
  /** 命中来源：bm25 / vector / exact / rrf（随 query 一并返回，UI 单路调用即可渲染来源徽标） */
  sources: string[]
}

interface KnowledgeQueryResponse {
  query: string
  answer: string
  citations: KnowledgeCitation[]
  /** 该轮问答落盘的历史会话 id（服务端新建/续用后回传，前端据此同步） */
  conversation_id?: string
}

interface KnowledgeReindexResponse {
  ok?: boolean
  docs: number
  chunks: number
  updated: number
  skipped: number
  removed: number
  failed: number
  elapsed: number
  /** 上传时返回：本次实际写入文件数 */
  written?: number
}

/** 用户自建知识库（GET /knowledge/kbs 的 kbs 元素） */
interface KnowledgeBase {
  id: string
  name: string
  created_at: string
  /** 文件数（files/ 目录实际文件数） */
  files: number
  /** chunk 数（chunks.jsonl 行数） */
  chunks: number
  /** 已建索引（有可检索 chunk） */
  indexed: boolean
}

/** 知识库内文件（GET /knowledge/kbs/<id>/files 的 files 元素） */
interface KnowledgeFile {
  /** 相对 files/ 的 posix 路径（子目录上传保留，删除/展示用） */
  rel: string
  name: string
  size: number
  mtime: number
}

/** 上传文件载荷（renderer → IPC → gateway multipart；data 经 ArrayBuffer 直传） */
interface KnowledgeUploadFile {
  /** 相对路径：上传文件夹用 webkitRelativePath，单文件用文件名 */
  relPath: string
  type: string
  size: number
  data: ArrayBuffer
}

/** 知识库索引状态（GET /knowledge/status） */
interface KnowledgeStatus {
  available: boolean
  /** 任一 KB 已建索引 */
  indexed: boolean
  /** 全部 KB 摘要列表 */
  kbs: KnowledgeBase[]
  embed_model: string
  last_error: string | null
  last_stats: KnowledgeReindexResponse | null
}

interface Window {
  api: {
    ping: () => Promise<unknown>
    platform: string
    sidecar: {
      getStatus: () => Promise<SidecarStatusInfo>
      /** 订阅 sidecar 状态变化，返回取消订阅函数 */
      onStatusChange: (cb: (status: SidecarStatus) => void) => () => void
    }
    chat: {
      send: (payload: {
        message: string
        conversationId: string
        provider?: ProviderKey
        depth?: DepthKey
        /** 本消息附带的附件 id 列表（sidecar 读取文件内容注入上下文） */
        attachment_ids?: string[]
      }) => Promise<{ ok: boolean }>
      stop: (conversationId: string) => Promise<{ ok: boolean }>
      /** 上传附件（ArrayBuffer 经 IPC → gateway multipart → sidecar），返回附件元数据 */
      upload: (payload: {
        conversationId: string
        name: string
        type: string
        size: number
        data: ArrayBuffer
      }) => Promise<Attachment>
      /** 删除附件 */
      deleteAttachment: (payload: { conversationId: string; id: string }) => Promise<{ ok: boolean }>
      /** 订阅流式对话事件，返回取消订阅函数 */
      onEvent: (cb: (ev: SidecarChatEvent) => void) => () => void
    }
    conversations: {
      /** 列出历史会话（标题/轮数/更新时间/预览） */
      list: () => Promise<{ conversations: ConversationSummary[] }>
      /** 读取单会话完整历史轮次 */
      get: (conversationId: string) => Promise<{ conversation_id: string; turns: ConversationTurn[] }>
      /** 删除历史会话（磁盘目录 + 附件一并清理） */
      delete: (conversationId: string) => Promise<{ deleted: string }>
    }
    knowledge: {
      /** 索引状态（available + 全部 KB 摘要），不触发重建 */
      status: () => Promise<KnowledgeStatus>
      /** 重建全部 KB 索引，返回最新统计 */
      reindex: (payload?: { incremental?: boolean }) => Promise<KnowledgeReindexResponse>
      /** 混合检索：可选 kb_id 限定单个知识库 */
      search: (payload: {
        query: string
        kb_id?: string
        top_n?: number
      }) => Promise<KnowledgeSearchResponse>
      /** 检索 + LLM 生成：可选 kb_id 限定单个知识库；conversation_id 指定落盘的历史会话 */
      query: (payload: {
        query: string
        kb_id?: string
        provider?: ProviderKey
        depth?: DepthKey
        top_n?: number
        conversation_id?: string
      }) => Promise<KnowledgeQueryResponse>
      /** 知识库列表 */
      kbs: () => Promise<{ kbs: KnowledgeBase[] }>
      /** 创建知识库 */
      createKb: (name: string) => Promise<{ ok: boolean; id: string; name: string }>
      /** 删除知识库（含索引目录） */
      deleteKb: (kbId: string) => Promise<{ ok: boolean }>
      /** 列出知识库内文件 */
      listKbFiles: (kbId: string) => Promise<{ kb_id: string; files: KnowledgeFile[] }>
      /** 上传文件到知识库（变更+重建一体，返回 stats） */
      uploadKbFiles: (payload: {
        kbId: string
        files: KnowledgeUploadFile[]
      }) => Promise<{ ok: boolean; stats: KnowledgeReindexResponse }>
      /** 删除知识库内文件（变更+重建一体） */
      deleteKbFile: (payload: { kbId: string; rel: string }) => Promise<{ ok: boolean; stats: KnowledgeReindexResponse }>
    }
    library: {
      /** 列出整棵文件夹/文件树（data/library/） */
      list: () => Promise<{ tree: LibraryNode[] }>
      /** 新建文件夹；parent='' 表示根 */
      createFolder: (payload: { parent: string; name: string }) => Promise<{ ok: boolean; node: LibraryNode }>
      /** 新建文件（自动补 .html 富文本片段）；parent='' 表示根 */
      createFile: (payload: { parent: string; name: string }) => Promise<{ ok: boolean; node: LibraryNode }>
      /** 递归删除文件夹（含其中全部内容） */
      deleteFolder: (relPath: string) => Promise<{ ok: boolean }>
      /** 删除单个文件 */
      deleteFile: (relPath: string) => Promise<{ ok: boolean }>
      /** 读取文件内容（utf8 文本） */
      readFile: (relPath: string) => Promise<{ content: string }>
      /** 写入文件内容（utf8 文本） */
      writeFile: (payload: { relPath: string; content: string }) => Promise<{ ok: boolean }>
      /** 写入 AI 整理的文档（创建或覆盖，父目录自动创建；TipTap 富文本 .html） */
      writeOrganize: (payload: {
        relPath: string
        content: string
      }) => Promise<{ ok: boolean; relPath: string; created: boolean }>
    }
  }
}
