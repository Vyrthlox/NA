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
    }
  }
}
