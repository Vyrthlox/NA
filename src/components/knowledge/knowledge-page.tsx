import { useEffect, useRef, useState } from 'react'
import { Database, Plus, Search, Trash2, X } from 'lucide-react'
import { useKnowledge } from '../../lib/use-knowledge'
import { cn } from '../../lib/cn'
import { KnowledgeBasePanel } from './knowledge-base-panel'

/** 右键知识库菜单：删除该知识库 */
interface KbMenuState {
  kb: KnowledgeBase
  x: number
  y: number
}

function clampMenuPos(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.min(x, Math.max(0, window.innerWidth - 152)),
    y: Math.min(y, Math.max(0, window.innerHeight - 48))
  }
}

/**
 * 知识库页：三栏布局（导航栏在 App 外层）——中间栏为全部知识库列表，右侧栏为选中知识库的详情面板。
 * 所有更改（建/删/传/删文件）经 hook 的 mutating 掩盖为顶部「正在更改」加载条。
 */
export default function KnowledgePage() {
  const {
    status,
    statusLoading,
    kbs,
    selectedKbId,
    selectedKb,
    kbFiles,
    filesLoading,
    mutating,
    mutationError,
    selectKb,
    createKb,
    deleteKb,
    uploadFiles,
    deleteFile,
    clearMutationError
  } = useKnowledge()

  const [naming, setNaming] = useState(false)
  const [menu, setMenu] = useState<KbMenuState | null>(null)
  const [confirming, setConfirming] = useState<KnowledgeBase | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  /** 中间列知识库搜索：展开输入框 + 名称过滤 */
  const [kbSearchOpen, setKbSearchOpen] = useState(false)
  const [kbFilter, setKbFilter] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const available = status?.available ?? false

  // 关闭右键菜单：点击任意处 / 再次右键 / Escape / 滚动
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  // 命名浮层输入框：挂载后全选默认名
  useEffect(() => {
    if (naming) inputRef.current?.select()
  }, [naming])

  // 关命名/确认浮层：Escape
  useEffect(() => {
    if (!naming && !confirming) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setNaming(false)
        setConfirming(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [naming, confirming])

  // 关知识库搜索：Escape
  useEffect(() => {
    if (!kbSearchOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setKbSearchOpen(false)
        setKbFilter('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [kbSearchOpen])

  const submitNaming = (): void => {
    const name = inputRef.current?.value.trim() ?? ''
    if (!name) {
      setCreateError('名称不能为空')
      return
    }
    setCreateError(null)
    setNaming(false)
    void createKb(name)
  }

  const statusText = statusLoading && !status
    ? '加载中…'
    : !available
      ? '索引准备中…'
      : `${kbs.length} 个知识库`

  // 知识库搜索过滤：按名称大小写不敏感匹配
  const visibleKbs = kbFilter.trim()
    ? kbs.filter((kb) => kb.name.toLowerCase().includes(kbFilter.trim().toLowerCase()))
    : kbs

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* 顶部：标题 + 状态 */}
      <header className="flex items-center justify-between border-b border-gray-200/70 px-6 py-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-medium text-gray-700">知识库</h2>
          <span className="text-xs text-gray-400">{statusText}</span>
        </div>
      </header>

      {/* 「正在更改」加载条：掩盖「更改 + 重建」一体执行 */}
      {mutating && (
        <div className="flex shrink-0 items-center gap-2 border-b border-green-100 bg-green-50/70 px-6 py-1.5">
          <div className="h-1 w-full max-w-[200px] animate-pulse rounded-full bg-green-400" />
          <span className="shrink-0 text-xs text-green-700">正在更改…</span>
        </div>
      )}

      {/* 更改错误条 */}
      {mutationError && (
        <div className="flex shrink-0 items-center justify-between border-b border-red-200 bg-red-50 px-6 py-1.5 text-xs text-red-600">
          <span>{mutationError}</span>
          <button
            type="button"
            onClick={clearMutationError}
            className="flex h-5 w-5 items-center justify-center rounded hover:bg-red-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* 三栏主体：导航栏在 App 外层；中间栏为全部知识库列表，右侧栏为选中知识库详情 */}
      <div className="flex min-h-0 flex-1">
        {/* 中间栏：全部知识库列表 */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-gray-200/70 bg-white">
          <div className="flex items-center justify-start px-3 pb-1 pt-3">
            <button
              type="button"
              title="搜索知识库"
              onClick={() => setKbSearchOpen((s) => !s)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              <Search className="h-4 w-4" />
            </button>
          </div>

          {/* 知识库搜索过滤栏 */}
          {kbSearchOpen && (
            <div className="px-3 pb-2">
              <input
                autoFocus
                value={kbFilter}
                onChange={(e) => setKbFilter(e.target.value)}
                placeholder="搜索知识库…"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-800 outline-none transition-colors placeholder:text-gray-400 focus:border-green-500"
              />
            </div>
          )}

          <div className="px-3 pb-2">
            <button
              type="button"
              onClick={() => {
                setCreateError(null)
                setNaming(true)
              }}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-500 transition-colors hover:border-green-400 hover:text-green-600"
            >
              <Plus className="h-3.5 w-3.5" />
              新建知识库
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
            {visibleKbs.length === 0 ? (
              kbFilter.trim() ? (
                <div className="px-2 py-6 text-center text-xs text-gray-400">无匹配知识库</div>
              ) : null
            ) : (
              visibleKbs.map((kb) => (
                <button
                  key={kb.id}
                  type="button"
                  onClick={() => selectKb(kb.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    const pos = clampMenuPos(e.clientX, e.clientY)
                    setMenu({ kb, x: pos.x, y: pos.y })
                  }}
                  title={`${kb.name}（${kb.files} 文件 · ${kb.chunks} chunks）`}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                    kb.id === selectedKbId ? 'bg-green-50 text-green-700' : 'text-gray-700 hover:bg-gray-50'
                  )}
                >
                  <Database
                    className={cn('h-4 w-4 shrink-0', kb.id === selectedKbId ? 'text-green-600' : 'text-gray-400')}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{kb.name}</span>
                    <span className="block text-[11px] text-gray-400">
                      {kb.files} 文件 · {kb.chunks} chunks
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        {/* 右侧栏：选中知识库详情面板（未选中时空态提示） */}
        <div className="flex min-h-0 min-w-0 flex-1">
          {selectedKb ? (
            <KnowledgeBasePanel
              kb={selectedKb}
              files={kbFiles}
              filesLoading={filesLoading}
              mutating={mutating}
              onClose={() => selectKb(null)}
              onUpload={uploadFiles}
              onDeleteFile={deleteFile}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <div className="text-center">
                <Database className="mx-auto h-8 w-8 text-gray-300" />
                <p className="mt-2 text-sm text-gray-400">
                  {kbs.length === 0 ? '点击左侧「新建知识库」开始' : '点击左侧知识库查看与管理文件'}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 知识库右键菜单：删除知识库 */}
      {menu && (
        <div
          className="fixed z-50 w-36 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            type="button"
            onClick={() => {
              setMenu(null)
              setConfirming(menu.kb)
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 transition-colors hover:bg-red-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除知识库
          </button>
        </div>
      )}

      {/* 命名浮层（自绘，替代 window.prompt） */}
      {naming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
          onClick={() => setNaming(false)}
        >
          <div
            className="w-80 rounded-xl border border-gray-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium text-gray-800">新建知识库</div>
            <div className="mt-1 text-xs leading-5 text-gray-400">
              每个知识库独立存储与索引，可上传你的笔记 / 文件夹
            </div>
            <input
              ref={inputRef}
              type="text"
              autoFocus
              defaultValue=""
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitNaming()
                else if (e.key === 'Escape') setNaming(false)
              }}
              placeholder="知识库名称"
              className="mt-3 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none transition-colors focus:border-green-500"
            />
            {createError && (
              <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-600">
                {createError}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setNaming(false)}
                className="h-9 rounded-lg px-3 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submitNaming}
                className="h-9 rounded-lg bg-green-500 px-3 text-xs font-medium text-white transition-colors hover:bg-green-600"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除知识库确认浮层（自绘，替代 window.confirm） */}
      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
          onClick={() => setConfirming(null)}
        >
          <div
            className="w-80 rounded-xl border border-gray-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium text-gray-800">删除该知识库？</div>
            <div className="mt-2 text-xs leading-5 text-gray-500">
              「{confirming.name}」将连同其中全部文件与索引一并删除，此操作不可恢复。
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="h-9 rounded-lg px-3 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={mutating}
                onClick={() => {
                  const id = confirming.id
                  setConfirming(null)
                  void deleteKb(id)
                }}
                className="h-9 rounded-lg bg-red-500 px-3 text-xs font-medium text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
