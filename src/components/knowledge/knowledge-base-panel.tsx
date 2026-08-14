import { useEffect, useRef, useState } from 'react'
import { Database, FileText, FolderOpen, FolderPlus, NotebookText, Search, Trash2, Upload, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { KB_ACCEPT, KB_ALLOWED_EXTS, KB_ALLOWED_LABEL, fileExt } from './kb-format'
import { LibraryFilePicker } from './library-file-picker'

interface KnowledgeBasePanelProps {
  kb: KnowledgeBase
  files: KnowledgeFile[]
  filesLoading: boolean
  /** 正在更改：在途时禁用上传等按钮（页面顶部另有「正在更改」加载条） */
  mutating: boolean
  onClose: () => void
  onUpload: (files: KnowledgeUploadFile[]) => Promise<void>
  onDeleteFile: (rel: string) => Promise<void>
}

/** 右键文件菜单 */
interface FileMenuState {
  rel: string
  name: string
  x: number
  y: number
}

function clampMenuPos(x: number, y: number, h: number): { x: number; y: number } {
  return {
    x: Math.min(x, Math.max(0, window.innerWidth - 152)),
    y: Math.min(y, Math.max(0, window.innerHeight - h))
  }
}

/**
 * 知识库详情面板：选中 KB 时占据三栏布局最右侧一栏（填充剩余宽度）。
 * 上栏（KB 图标 + 名字 + 右上角小 x）+ 横线 + 下栏（[搜索][+上传] 工具行 + 搜索过滤 + 文件列表）。
 * 文件列表右键删除；上传三选项【本地上传】【上传文件夹】【从笔记库上传（应用内文件）】。
 */
export function KnowledgeBasePanel({
  kb,
  files,
  filesLoading,
  mutating,
  onClose,
  onUpload,
  onDeleteFile
}: KnowledgeBasePanelProps) {
  const [showSearch, setShowSearch] = useState(false)
  const [filter, setFilter] = useState('')
  const [showUploadMenu, setShowUploadMenu] = useState(false)
  const [showLibraryPicker, setShowLibraryPicker] = useState(false)
  const [fileMenu, setFileMenu] = useState<FileMenuState | null>(null)
  const [confirmingFile, setConfirmingFile] = useState<{ rel: string; name: string } | null>(null)
  /** 因格式不支持而被跳过的文件名（上传选择后展示，数秒后自动消失） */
  const [skippedFiles, setSkippedFiles] = useState<string[]>([])
  const localInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  const filtered = filter.trim()
    ? files.filter((f) => f.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : files

  // 关闭浮层：点击任意处 / Escape / 滚动
  useEffect(() => {
    if (!showUploadMenu && !fileMenu) return
    const close = (): void => {
      setShowUploadMenu(false)
      setFileMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        close()
        setShowSearch(false)
        setFilter('')
      }
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [showUploadMenu, fileMenu])

  /** 读取并白名单过滤：不支持的扩展名记入 skipped 提示，不读取内容。 */
  const readFiles = async (
    fileList: FileList | null
  ): Promise<{ accepted: KnowledgeUploadFile[]; skipped: string[] }> => {
    const accepted: KnowledgeUploadFile[] = []
    const skipped: string[] = []
    for (const f of Array.from(fileList ?? [])) {
      // webkitdirectory 会带入目录占位项（无名字）→ 跳过
      if (!f.name) continue
      if (!KB_ALLOWED_EXTS.includes(fileExt(f.name))) {
        skipped.push(f.name)
        continue
      }
      accepted.push({
        relPath: f.webkitRelativePath || f.name,
        type: f.type || 'application/octet-stream',
        size: f.size,
        data: await f.arrayBuffer()
      })
    }
    return { accepted, skipped }
  }

  const handleLocalUpload = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const { accepted, skipped } = await readFiles(e.target.files)
    e.target.value = '' // 允许重复选择同一文件
    if (skipped.length > 0) setSkippedFiles(skipped)
    if (accepted.length > 0) void onUpload(accepted)
  }

  // 跳过提示 6 秒后自动消失
  useEffect(() => {
    if (skippedFiles.length === 0) return
    const t = window.setTimeout(() => setSkippedFiles([]), 6000)
    return () => window.clearTimeout(t)
  }, [skippedFiles])

  const uploadMenuButtonCls =
    'flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50'
  const toolbarBtnCls = cn(
    'flex h-7 w-7 items-center justify-center rounded-md text-gray-500 transition-colors',
    mutating ? 'cursor-not-allowed text-gray-300' : 'hover:bg-gray-100 hover:text-gray-700'
  )

  return (
    <aside className="relative flex min-w-0 flex-1 flex-col bg-white">
      {/* 上栏：KB 图标 + 名字；右上角小 x 关闭面板 */}
      <div className="relative flex flex-col items-center gap-1.5 py-5">
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-green-100 text-green-600">
          <Database className="h-5 w-5" />
        </div>
        <span className="max-w-[15rem] truncate text-sm font-medium text-gray-800">{kb.name}</span>
        <span className="text-[11px] text-gray-400">
          {kb.files} 文件 · {kb.chunks} chunks
        </span>
      </div>

      {/* 上下栏横线分隔 */}
      <div className="border-t border-gray-200/70" />

      {/* 下栏：工具行 + 搜索 + 文件列表 */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* 工具行：搜索 / 上传（有图标即可，无需文字） */}
        <div className="relative flex items-center gap-1 px-3 py-2">
          <button
            type="button"
            title="搜索文件"
            disabled={mutating}
            onClick={() => setShowSearch((s) => !s)}
            className={toolbarBtnCls}
          >
            <Search className="h-4 w-4" />
          </button>
          <button
            type="button"
            title={`上传文件（支持 ${KB_ALLOWED_LABEL}）`}
            disabled={mutating}
            onClick={(e) => {
              // stopPropagation：窗口外点关闭监听挂在 click 上，React 离散事件同步 flush 会让
              // 同一次打开的点击立刻触发 close 把菜单关掉（真机鼠标必现）→ 阻止冒泡到 window
              e.stopPropagation()
              setShowUploadMenu((s) => !s)
            }}
            className={toolbarBtnCls}
          >
            <Upload className="h-4 w-4" />
          </button>

          {/* 上传三选项 */}
          {showUploadMenu && (
            <div className="absolute left-3 top-10 z-20 w-36 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
              <button
                type="button"
                className={uploadMenuButtonCls}
                onClick={() => {
                  setShowUploadMenu(false)
                  localInputRef.current?.click()
                }}
              >
                <FolderOpen className="h-3.5 w-3.5 text-gray-400" />
                本地上传
              </button>
              <button
                type="button"
                className={uploadMenuButtonCls}
                onClick={() => {
                  setShowUploadMenu(false)
                  folderInputRef.current?.click()
                }}
              >
                <FolderPlus className="h-3.5 w-3.5 text-gray-400" />
                上传文件夹
              </button>
              <button
                type="button"
                className={uploadMenuButtonCls}
                onClick={() => {
                  setShowUploadMenu(false)
                  setShowLibraryPicker(true)
                }}
              >
                <NotebookText className="h-3.5 w-3.5 text-gray-400" />
                从笔记库上传
              </button>
            </div>
          )}
        </div>

        {/* 格式不支持被跳过的提示（自绘，替代 window.alert） */}
        {skippedFiles.length > 0 && (
          <div className="mx-3 mb-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <span className="min-w-0 flex-1 text-xs leading-5 text-amber-700">
              已跳过 {skippedFiles.length} 个不支持的文件（{skippedFiles.slice(0, 3).join('、')}
              {skippedFiles.length > 3 ? ' 等' : ''}）。仅支持 {KB_ALLOWED_LABEL}
            </span>
            <button
              type="button"
              onClick={() => setSkippedFiles([])}
              className="shrink-0 rounded p-0.5 text-amber-400 transition-colors hover:bg-amber-100 hover:text-amber-600"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* 搜索过滤栏 */}
        {showSearch && (
          <div className="px-3 pb-2">
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="搜索文件…"
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-800 outline-none transition-colors placeholder:text-gray-400 focus:border-green-500"
            />
          </div>
        )}

        {/* 文件列表 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {filesLoading ? (
            <div className="py-6 text-center text-xs text-gray-400">加载中…</div>
          ) : filtered.length === 0 ? (
            <div className="py-6 text-center text-xs text-gray-400">
              {filter ? '无匹配文件' : files.length === 0 ? '暂无文件，点击上方上传' : ''}
            </div>
          ) : (
            <div className="space-y-0.5">
              {filtered.map((f) => (
                <button
                  key={f.rel}
                  type="button"
                  title={f.rel}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    const pos = clampMenuPos(e.clientX, e.clientY, 48)
                    setFileMenu({ rel: f.rel, name: f.name, x: pos.x, y: pos.y })
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-50"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                  <span className="min-w-0 flex-1 truncate text-left">{f.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 文件右键菜单：删除 */}
      {fileMenu && (
        <div
          className="fixed z-50 w-36 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
          style={{ left: fileMenu.x, top: fileMenu.y }}
        >
          <button
            type="button"
            onClick={() => {
              setFileMenu(null)
              setConfirmingFile({ rel: fileMenu.rel, name: fileMenu.name })
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 transition-colors hover:bg-red-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </button>
        </div>
      )}

      {/* 删除文件确认浮层（自绘，替代 window.confirm） */}
      {confirmingFile && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
          onClick={() => setConfirmingFile(null)}
        >
          <div
            className="w-80 rounded-xl border border-gray-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium text-gray-800">删除该文件？</div>
            <div className="mt-2 text-xs leading-5 text-gray-500">
              「{confirmingFile.name}」将从知识库移除并重建索引，此操作不可恢复。
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmingFile(null)}
                className="h-9 rounded-lg px-3 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={mutating}
                onClick={() => {
                  const rel = confirmingFile.rel
                  setConfirmingFile(null)
                  void onDeleteFile(rel)
                }}
                className="h-9 rounded-lg bg-red-500 px-3 text-xs font-medium text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 隐藏文件输入：本地上传 + 上传文件夹（accept 与白名单一致；最终以后端校验为准） */}
      <input ref={localInputRef} type="file" multiple accept={KB_ACCEPT} className="hidden" onChange={handleLocalUpload} />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        accept={KB_ACCEPT}
        className="hidden"
        onChange={handleLocalUpload}
        {...({ webkitdirectory: '' } as Record<string, string>)}
      />

      {/* 从笔记库上传：双栏选择器（应用内文件，读内容后经 onUpload 管线） */}
      {showLibraryPicker && (
        <LibraryFilePicker onCancel={() => setShowLibraryPicker(false)} onUpload={onUpload} />
      )}
    </aside>
  )
}
