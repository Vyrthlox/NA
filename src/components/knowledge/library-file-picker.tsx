import { useEffect, useState } from 'react'
import { ChevronRight, FileText, Folder, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useLibrary } from '../../lib/use-library'
import { displayFileName } from '../../lib/library-name'
import { KB_ALLOWED_EXTS, KB_ALLOWED_LABEL, fileExt, mimeFromExt } from './kb-format'

interface LibraryFilePickerProps {
  /** 关闭选择器（backdrop / X / Escape / 上传完成） */
  onCancel: () => void
  /** 上传所选文件（父级 uploadFiles → runMutation →「正在更改」条） */
  onUpload: (files: KnowledgeUploadFile[]) => Promise<void>
}

/** 递归找节点及其祖先链（面包屑 / 当前目录用）；找不到返回 null */
function collectPath(nodes: LibraryNode[], targetId: string, trail: LibraryNode[] = []): LibraryNode[] | null {
  for (const n of nodes) {
    const next = [...trail, n]
    if (n.id === targetId) return next
    if (n.type === 'folder' && n.children && n.children.length > 0) {
      const found = collectPath(n.children, targetId, next)
      if (found) return found
    }
  }
  return null
}

interface FolderRowProps {
  node: LibraryNode
  depth: number
  currentId: string
  expanded: Record<string, boolean>
  onNavigate: (node: LibraryNode) => void
}

/** 左树单行：点击 = 选中当前目录 + 确保展开（非文件树那种「开文件」语义） */
function FolderRow({ node, depth, currentId, expanded, onNavigate }: FolderRowProps) {
  if (node.type !== 'folder') return null
  const isOpen = !!expanded[node.id]
  const isCurrent = node.id === currentId
  return (
    <div>
      <button
        type="button"
        onClick={() => onNavigate(node)}
        title={node.id}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm transition-colors',
          isCurrent ? 'bg-green-50 text-green-700' : 'text-gray-700 hover:bg-gray-50'
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform duration-150',
            isOpen && 'rotate-90'
          )}
        />
        <Folder className="h-4 w-4 shrink-0 text-amber-500" />
        <span className="min-w-0 flex-1 truncate text-left">{node.name}</span>
      </button>
      {isOpen && (node.children?.length ?? 0) > 0 && (
        <div>
          {node.children?.map((child) => (
            <FolderRow
              key={child.id}
              node={child}
              depth={depth + 1}
              currentId={currentId}
              expanded={expanded}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 「从笔记库上传」双栏选择器（自绘模态，替代系统文件框）：
 * 左侧文件夹树 + 右侧当前目录文件列表（多选），选择应用内创建的笔记上传到知识库。
 * 选中的文件读 utf8 内容 → UTF-8 字节 ArrayBuffer，relPath 直接用 LibraryNode.id
 * （posix 相对路径，保留笔记库的文件夹层级）。
 */
export function LibraryFilePicker({ onCancel, onUpload }: LibraryFilePickerProps) {
  const { tree, loading, readFile } = useLibrary()
  /** 当前浏览目录 id（'' = 根）；导航只把 currentId 设为文件夹 id */
  const [currentId, setCurrentId] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  /** 全局选中集（key=id，跨目录保留，可多目录勾选后一次上传） */
  const [selected, setSelected] = useState<Record<string, LibraryNode>>({})
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedCount = Object.keys(selected).length

  // 树刷新后 currentId 指向的目录已不存在 → 回退根
  useEffect(() => {
    if (currentId && !collectPath(tree, currentId)) setCurrentId('')
  }, [currentId, tree])

  // Escape 关闭（backdrop onClick 关闭天然免疫 React 19 点击冒泡坑，见 na-knowledge-rag）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const navigateTo = (node: LibraryNode): void => {
    setCurrentId(node.id)
    setExpanded((prev) => ({ ...prev, [node.id]: true }))
  }

  const toggleSelect = (node: LibraryNode): void => {
    if (!KB_ALLOWED_EXTS.includes(fileExt(node.name))) return
    setSelected((prev) => {
      const next = { ...prev }
      if (next[node.id]) delete next[node.id]
      else next[node.id] = node
      return next
    })
  }

  const rawPath = currentId ? collectPath(tree, currentId) : []
  const folderPath = rawPath && rawPath.length > 0 && rawPath[rawPath.length - 1].type === 'folder' ? rawPath : []
  const currentFolder = folderPath.length > 0 ? folderPath[folderPath.length - 1] : null
  const currentChildren = currentFolder?.children ?? tree

  const handleUpload = async (): Promise<void> => {
    const nodes = Object.values(selected)
    if (nodes.length === 0) return
    setReading(true)
    setError(null)
    try {
      const files: KnowledgeUploadFile[] = []
      for (const n of nodes) {
        const content = await readFile(n.id)
        const bytes = new TextEncoder().encode(content)
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        files.push({ relPath: n.id, type: mimeFromExt(n.name), size: data.byteLength, data })
      }
      await onUpload(files)
      onCancel()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setReading(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
      onClick={onCancel}
    >
      <div
        className="flex h-[70vh] w-[640px] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-gray-200/70 px-4 py-3">
          <span className="text-sm font-medium text-gray-800">从笔记库上传</span>
          <button
            type="button"
            onClick={onCancel}
            title="关闭"
            className="flex h-6 w-6 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 提示 */}
        <div className="border-b border-gray-200/70 px-4 py-2 text-xs text-gray-400">
          选择你在应用内创建的笔记上传到知识库（仅支持 {KB_ALLOWED_LABEL}）
        </div>

        {/* 错误条 */}
        {error && (
          <div className="border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-600">{error}</div>
        )}

        {/* 双栏主体 */}
        <div className="flex min-h-0 flex-1">
          {/* 左栏：文件夹树 */}
          <div className="w-48 shrink-0 overflow-y-auto border-r border-gray-200/70 px-2 py-2">
            <button
              type="button"
              onClick={() => setCurrentId('')}
              className={cn(
                'flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm transition-colors',
                currentId === '' ? 'bg-green-50 text-green-700' : 'text-gray-700 hover:bg-gray-50'
              )}
            >
              <span className="w-3.5 shrink-0" />
              <Folder className="h-4 w-4 shrink-0 text-amber-500" />
              <span className="min-w-0 flex-1 truncate text-left">根目录</span>
            </button>
            {loading ? (
              <div className="px-2 py-3 text-xs text-gray-400">加载中…</div>
            ) : (
              tree.map((node) => (
                <FolderRow
                  key={node.id}
                  node={node}
                  depth={0}
                  currentId={currentId}
                  expanded={expanded}
                  onNavigate={navigateTo}
                />
              ))
            )}
          </div>

          {/* 右栏：面包屑 + 当前目录内容 */}
          <div className="flex min-h-0 flex-1 flex-col">
            {/* 面包屑 */}
            <div className="flex items-center gap-1 border-b border-gray-200/70 px-3 py-2 text-xs">
              <button
                type="button"
                onClick={() => setCurrentId('')}
                className={cn(
                  'rounded px-1 py-0.5 transition-colors',
                  currentId === ''
                    ? 'font-medium text-green-700'
                    : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                )}
              >
                根目录
              </button>
              {folderPath.map((n, i) => (
                <span key={n.id} className="flex items-center gap-1">
                  <span className="text-gray-300">/</span>
                  <button
                    type="button"
                    onClick={() => setCurrentId(n.id)}
                    className={cn(
                      'rounded px-1 py-0.5 transition-colors',
                      i === folderPath.length - 1
                        ? 'font-medium text-green-700'
                        : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                    )}
                  >
                    {n.name}
                  </button>
                </span>
              ))}
            </div>

            {/* 文件 / 子文件夹列表 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {currentChildren.length === 0 ? (
                <div className="px-2 py-6 text-center text-xs text-gray-400">空文件夹</div>
              ) : (
                currentChildren.map((node) =>
                  node.type === 'folder' ? (
                    <button
                      key={node.id}
                      type="button"
                      onClick={() => navigateTo(node)}
                      title={node.id}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-50"
                    >
                      <span className="w-3.5 shrink-0" />
                      <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                      <span className="min-w-0 flex-1 truncate text-left">{node.name}</span>
                    </button>
                  ) : (
                    (() => {
                      const selectable = KB_ALLOWED_EXTS.includes(fileExt(node.name))
                      return (
                        <div
                          key={node.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => toggleSelect(node)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                            selectable ? 'cursor-pointer text-gray-700 hover:bg-gray-50' : 'cursor-not-allowed text-gray-300'
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={!!selected[node.id]}
                            disabled={!selectable}
                            onChange={() => toggleSelect(node)}
                            onClick={(e) => e.stopPropagation()}
                            className="h-3.5 w-3.5 shrink-0 accent-green-500"
                          />
                          <FileText className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                          <span className="min-w-0 flex-1 truncate text-left">{displayFileName(node.name)}</span>
                          {!selectable && <span className="shrink-0 text-[10px] text-gray-400">不支持</span>}
                        </div>
                      )
                    })()
                  )
                )
              )}
            </div>
          </div>
        </div>

        {/* 底部操作栏 */}
        <div className="flex items-center justify-between border-t border-gray-200/70 px-4 py-3">
          <span className="text-xs text-gray-500">
            {selectedCount > 0 ? `已选 ${selectedCount} 个` : '未选择文件'}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="h-9 rounded-lg px-3 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
            >
              取消
            </button>
            <button
              type="button"
              disabled={selectedCount === 0 || reading}
              onClick={handleUpload}
              className="h-9 rounded-lg bg-green-500 px-3 text-xs font-medium text-white transition-colors hover:bg-green-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {reading ? '上传中…' : '上传'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
