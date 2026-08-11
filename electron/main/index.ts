import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { SidecarConfig } from './sidecar/config'
import { SidecarManager } from './sidecar/manager'
import { GatewayClient, type DepthKey, type ProviderKey } from './gateway/client'
import * as library from './library/store'

const sidecarManager = new SidecarManager(new SidecarConfig())
const gateway = new GatewayClient(sidecarManager)

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false, // 配合 ready-to-show，避免白屏闪烁
    autoHideMenuBar: true,
    backgroundColor: '#f7f8fa', // 与主内容区底色一致
    title: 'NA',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, // 安全基线
      sandbox: true, // 安全基线
      nodeIntegration: false,
      webSecurity: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // 外链一律交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // dev：electron-vite 注入的 dev server URL；prod：out/renderer/index.html
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.na.app')

  // sidecar 状态查询 + 状态变化广播到所有窗口
  ipcMain.handle('sidecar:get-status', () => sidecarManager.statusInfo())
  sidecarManager.on('status', (status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('sidecar:status', status)
    }
  })

  // 流式对话：renderer 发起 → gateway 拉 SSE → chat:event 转发回请求窗口
  ipcMain.handle(
    'chat:send',
    (event, payload: { message?: string; conversationId?: string; provider?: ProviderKey; depth?: DepthKey; attachment_ids?: string[] }) => {
      const message = (payload?.message ?? '').trim()
      const conversationId = payload?.conversationId
      // 模型选择：provider（deepseek/qwen，默认 deepseek）× 档位（fast/deep，默认 fast）
      const provider = payload?.provider ?? 'deepseek'
      const depth = payload?.depth ?? 'fast'
      // 附件 id 列表（可选）：数组且元素为 string 才透传，否则按空处理
      const attachmentIds = Array.isArray(payload?.attachment_ids)
        ? payload.attachment_ids.filter((id): id is string => typeof id === 'string')
        : []
      if (!message) throw new Error('消息不能为空')
      if (!conversationId) throw new Error('缺少 conversationId')
      if (provider !== 'deepseek' && provider !== 'qwen') {
        throw new Error('无效的 provider')
      }
      if (depth !== 'fast' && depth !== 'deep') {
        throw new Error('无效的 depth')
      }
      if (!gateway.isReady()) throw new Error('AI 引擎尚未就绪')
      const win = BrowserWindow.fromWebContents(event.sender)
      void gateway
        .sendChat(conversationId, message, (ev) => {
          win?.webContents.send('chat:event', ev)
        }, provider, depth, attachmentIds)
        .catch((err: unknown) => {
          // 主动停止（abort）不算错误，前端已自行收起流式状态
          if (err instanceof Error && err.name === 'AbortError') return
          win?.webContents.send('chat:event', {
            conversationId,
            type: 'error',
            data: { error: err instanceof Error ? err.message : String(err) }
          })
        })
      return { ok: true }
    }
  )

  ipcMain.handle('chat:stop', (_event, conversationId: string) => {
    gateway.abort(conversationId)
    return { ok: true }
  })

  // 附件上传（仅保存展示）：renderer 读文件为 ArrayBuffer → IPC → gateway multipart → sidecar
  ipcMain.handle(
    'attachments:upload',
    async (_event, payload: { conversationId?: string; name?: string; type?: string; data?: unknown }) => {
      if (!payload?.conversationId) throw new Error('缺少 conversationId')
      const name = payload.name ?? ''
      if (!name) throw new Error('缺少文件名')
      const data = payload.data
      let bytes: ArrayBuffer
      if (data instanceof ArrayBuffer) {
        bytes = data
      } else if (data instanceof Uint8Array) {
        // 复制到独立 ArrayBuffer（避免 SharedArrayBuffer 类型不兼容）
        const copy = new Uint8Array(data.byteLength)
        copy.set(data)
        bytes = copy.buffer
      } else {
        throw new Error('缺少文件内容')
      }
      if (bytes.byteLength <= 0) throw new Error('文件内容为空')
      return gateway.uploadAttachment({ conversationId: payload.conversationId, name, type: payload.type ?? '', data: bytes })
    }
  )

  ipcMain.handle('attachments:delete', (_event, payload: { conversationId?: string; id?: string }) => {
    if (!payload?.conversationId) throw new Error('缺少 conversationId')
    if (!payload?.id) throw new Error('缺少附件 id')
    return gateway.deleteAttachment({ conversationId: payload.conversationId, id: payload.id })
  })

  // 历史会话查询：列表 + 单会话详情 + 删除（前端右侧「历史对话」面板）
  ipcMain.handle('conversations:list', () => gateway.listConversations())
  ipcMain.handle('conversations:get', (_event, conversationId: string) => {
    const id = (conversationId ?? '').trim()
    if (!id) throw new Error('缺少 conversationId')
    return gateway.getConversation(id)
  })
  ipcMain.handle('conversations:delete', (_event, conversationId: string) => {
    const id = (conversationId ?? '').trim()
    if (!id) throw new Error('缺少 conversationId')
    return gateway.deleteConversation(id)
  })

  // 文件库：文件夹/文件树（真实文件系统 data/library/），全部经主进程 fs 操作
  ipcMain.handle('library:list', async () => {
    return { tree: await library.list() }
  })
  ipcMain.handle(
    'library:create-folder',
    async (_event, payload: { parent?: string; name?: string }) => {
      const parent = payload?.parent ?? ''
      const name = (payload?.name ?? '').trim()
      if (!name) throw new Error('名称不能为空')
      return { ok: true, node: await library.createFolder(parent, name) }
    }
  )
  ipcMain.handle(
    'library:create-file',
    async (_event, payload: { parent?: string; name?: string }) => {
      const parent = payload?.parent ?? ''
      const name = (payload?.name ?? '').trim()
      if (!name) throw new Error('名称不能为空')
      return { ok: true, node: await library.createFile(parent, name) }
    }
  )
  ipcMain.handle('library:delete-folder', async (_event, relPath: string) => {
    const p = (relPath ?? '').trim()
    if (!p) throw new Error('缺少路径')
    await library.deleteFolder(p)
    return { ok: true }
  })
  ipcMain.handle('library:delete-file', async (_event, relPath: string) => {
    const p = (relPath ?? '').trim()
    if (!p) throw new Error('缺少路径')
    await library.deleteFile(p)
    return { ok: true }
  })
  // 文件读写：富文本编辑器打开/自动保存
  ipcMain.handle('library:read-file', async (_event, relPath: string) => {
    const p = (relPath ?? '').trim()
    if (!p) throw new Error('缺少路径')
    return { content: await library.readFile(p) }
  })
  ipcMain.handle(
    'library:write-file',
    async (_event, payload: { relPath?: string; content?: string }) => {
      const p = (payload?.relPath ?? '').trim()
      if (!p) throw new Error('缺少路径')
      if (typeof payload?.content !== 'string') throw new Error('内容格式无效')
      await library.writeFile(p, payload.content)
      return { ok: true }
    }
  )

  createWindow()

  // 不阻塞窗口创建，sidecar 就绪后通过 'status' 事件通知 renderer
  void sidecarManager.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 退出时回收 sidecar 子进程
app.on('before-quit', () => {
  void sidecarManager.stop()
})
// 强制退出（Ctrl+C / 崩溃）时的同步兜底
process.on('exit', () => sidecarManager.killSync())
