import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

// sidecar 状态类型与 src/env.d.ts 保持一致（避免跨 bundle 引 main 的类型）
type SidecarStatus = 'starting' | 'ready' | 'stopped' | 'crashed' | 'failed'
type ProviderKey = 'deepseek' | 'qwen'
type DepthKey = 'fast' | 'deep'
type Unsubscribe = () => void

/** 与 electron/main/gateway/client.ts 的 ChatStreamEvent 一致 */
interface ChatEvent {
  conversationId: string
  type: 'meta' | 'chunk' | 'done' | 'error'
  data: unknown
}

// window.api 占位：后续按架构文档扩展 notebook/note/ai/knowledge 系列 IPC
const api = {
  ping: (): Promise<unknown> => ipcRenderer.invoke('ping'),
  platform: process.platform,
  sidecar: {
    getStatus: (): Promise<unknown> => ipcRenderer.invoke('sidecar:get-status'),
    onStatusChange: (cb: (status: SidecarStatus) => void): Unsubscribe => {
      const listener = (_e: IpcRendererEvent, status: SidecarStatus): void => cb(status)
      ipcRenderer.on('sidecar:status', listener)
      return () => {
        ipcRenderer.removeListener('sidecar:status', listener)
      }
    }
  },
  chat: {
    send: (payload: {
      message: string
      conversationId: string
      provider?: ProviderKey
      depth?: DepthKey
      attachment_ids?: string[]
    }): Promise<{ ok: boolean }> => ipcRenderer.invoke('chat:send', payload),
    stop: (conversationId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('chat:stop', conversationId),
    upload: (payload: {
      conversationId: string
      name: string
      type: string
      size: number
      data: ArrayBuffer
    }): Promise<unknown> => ipcRenderer.invoke('attachments:upload', payload),
    deleteAttachment: (payload: { conversationId: string; id: string }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('attachments:delete', payload),
    onEvent: (cb: (ev: ChatEvent) => void): Unsubscribe => {
      const listener = (_e: IpcRendererEvent, ev: ChatEvent): void => cb(ev)
      ipcRenderer.on('chat:event', listener)
      return () => {
        ipcRenderer.removeListener('chat:event', listener)
      }
    }
  },
  conversations: {
    list: (): Promise<unknown> => ipcRenderer.invoke('conversations:list'),
    get: (conversationId: string): Promise<unknown> => ipcRenderer.invoke('conversations:get', conversationId),
    delete: (conversationId: string): Promise<unknown> => ipcRenderer.invoke('conversations:delete', conversationId)
  },
  knowledge: {
    /** 索引状态（available + 全部 KB 摘要），不触发重建 */
    status: (): Promise<unknown> => ipcRenderer.invoke('knowledge:status'),
    /** 重建全部 KB 索引 */
    reindex: (payload?: { incremental?: boolean }): Promise<unknown> =>
      ipcRenderer.invoke('knowledge:reindex', payload),
    /** 混合检索：可选 kb_id 限定单个知识库 */
    search: (payload: { query: string; kb_id?: string; top_n?: number }): Promise<unknown> =>
      ipcRenderer.invoke('knowledge:search', payload),
    /** 检索 + LLM 生成：可选 kb_id 限定单个知识库；conversation_id 指定落盘的历史会话 */
    query: (payload: {
      query: string
      kb_id?: string
      provider?: ProviderKey
      depth?: DepthKey
      top_n?: number
      conversation_id?: string
    }): Promise<unknown> => ipcRenderer.invoke('knowledge:query', payload),
    /** 知识库列表（id/name/created_at/files/chunks/indexed） */
    kbs: (): Promise<unknown> => ipcRenderer.invoke('knowledge:kbs'),
    /** 创建知识库 */
    createKb: (name: string): Promise<unknown> => ipcRenderer.invoke('knowledge:kbs:create', { name }),
    /** 删除知识库（含索引目录） */
    deleteKb: (kbId: string): Promise<unknown> => ipcRenderer.invoke('knowledge:kbs:delete', kbId),
    /** 列出知识库内文件 */
    listKbFiles: (kbId: string): Promise<unknown> => ipcRenderer.invoke('knowledge:kbs:files', kbId),
    /** 上传文件到知识库（变更+重建一体，服务端返回 stats） */
    uploadKbFiles: (payload: {
      kbId: string
      files: { relPath: string; type: string; data: ArrayBuffer }[]
    }): Promise<unknown> => ipcRenderer.invoke('knowledge:kbs:upload', payload),
    /** 删除知识库内文件（变更+重建一体） */
    deleteKbFile: (payload: { kbId: string; rel: string }): Promise<unknown> =>
      ipcRenderer.invoke('knowledge:kbs:delete-file', payload)
  },
  library: {
    /** 列出整棵文件夹/文件树（data/library/） */
    list: (): Promise<unknown> => ipcRenderer.invoke('library:list'),
    /** 新建文件夹；parent='' 表示根 */
    createFolder: (payload: { parent: string; name: string }): Promise<unknown> =>
      ipcRenderer.invoke('library:create-folder', payload),
    /** 新建文件（自动补 .html 富文本片段）；parent='' 表示根 */
    createFile: (payload: { parent: string; name: string }): Promise<unknown> =>
      ipcRenderer.invoke('library:create-file', payload),
    /** 递归删除文件夹（含其中全部内容） */
    deleteFolder: (relPath: string): Promise<unknown> => ipcRenderer.invoke('library:delete-folder', relPath),
    /** 删除单个文件 */
    deleteFile: (relPath: string): Promise<unknown> => ipcRenderer.invoke('library:delete-file', relPath),
    /** 读取文件内容（utf8 文本） */
    readFile: (relPath: string): Promise<unknown> => ipcRenderer.invoke('library:read-file', relPath),
    /** 写入文件内容（utf8 文本） */
    writeFile: (payload: { relPath: string; content: string }): Promise<unknown> =>
      ipcRenderer.invoke('library:write-file', payload),
    /** 写入 AI 整理的文档（创建或覆盖，父目录自动创建；TipTap 富文本 .html） */
    writeOrganize: (payload: { relPath: string; content: string }): Promise<unknown> =>
      ipcRenderer.invoke('library:write-organize', payload)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // contextIsolation 关闭时的 fallback（当前恒为 true，仅为完整性）
  ;(globalThis as unknown as { api: typeof api }).api = api
}
