import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, FileText, Folder, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useLibrary } from '../../lib/use-library'

interface OrganizeDialogProps {
  onClose: () => void
  /** 用户确认路径后回调（父级据此发送 @organize <relPath>） */
  onSubmit: (relPath: string) => void
}

/** Windows 文件名非法字符（与主进程 store.ts 的校验一致） */
const INVALID_NAME_CHARS = /[\\/:*?"<>|]/

function findNode(nodes: LibraryNode[], id: string): LibraryNode | null {
  for (const n of nodes) {
    if (n.id === id) return n
    if (n.type === 'folder' && n.children) {
      const found = findNode(n.children, id)
      if (found) return found
    }
  }
  return null
}

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

/** 默认文件名：对话整理-YYYYMMDD-HHmm.html（与文件库 TipTap 富文本格式一致） */
function defaultFileName(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `对话整理-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.html`
}

interface FolderRowProps {
  node: LibraryNode
  depth: number
  currentId: string
  expanded: Record<string, boolean>
  onNavigate: (node: LibraryNode) => void
}

/** 左树单行（递归）：点击 = 选中当前目录 + 展开；文件夹才渲染 */
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
 * 「将对话整理为文档」三步自绘浮层（替代原生 confirm/prompt）：
 * 1) 二次确认 → 2) 选择保存目录（文件库文件夹树）+ 文件名（已存在则 3) 覆盖确认）。
 * 确认后以相对路径（如 "设计文档/需求.html"）回调 onSubmit。
 */
export function OrganizeDialog({ onClose, onSubmit }: OrganizeDialogProps) {
  const { tree } = useLibrary()
  const [step, setStep] = useState<'confirm' | 'save' | 'overwrite'>('confirm')
  const [currentId, setCurrentId] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [fileName, setFileName] = useState(defaultFileName())
  const [pendingRelPath, setPendingRelPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Escape 关闭（backdrop onClick 关闭天然免疫 React 19 点击冒泡坑）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 进入保存步时聚焦文件名输入并全选，便于直接覆盖
  useEffect(() => {
    if (step === 'save') inputRef.current?.select()
  }, [step])

  const folderPath = useMemo(
    () => (currentId ? collectPath(tree, currentId) ?? [] : []),
    [currentId, tree]
  )
  const currentFolder =
    folderPath.length > 0 && folderPath[folderPath.length - 1].type === 'folder'
      ? folderPath[folderPath.length - 1]
      : null
  const currentChildren = currentFolder?.children ?? tree

  const navigateTo = (node: LibraryNode): void => {
    setCurrentId(node.id)
    setExpanded((prev) => ({ ...prev, [node.id]: true }))
  }

  /** 校验文件名 + 检查目标是否已存在；不存在直接提交，存在则进入覆盖确认 */
  const confirmSave = (): void => {
    const name = fileName.trim()
    if (!name) {
      setError('文件名不能为空')
      return
    }
    if (name === '.' || name === '..') {
      setError('文件名无效')
      return
    }
    if (INVALID_NAME_CHARS.test(name)) {
      setError('文件名不能包含 \\ / : * ? " < > | 等字符')
      return
    }
    if (name.endsWith('.') || name.endsWith(' ')) {
      setError('文件名不能以空格或点结尾')
      return
    }
    let full = name
    if (!/\.html?$/i.test(full)) full += '.html'
    const relPath = currentId ? `${currentId}/${full}` : full
    setError(null)
    if (findNode(tree, relPath)) {
      setPendingRelPath(relPath)
      setStep('overwrite')
    } else {
      onSubmit(relPath)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={onClose}>
      {/* 步骤 1：二次确认 */}
      {step === 'confirm' && (
        <div
          className="w-80 rounded-xl border border-gray-200 bg-white p-5 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-sm font-medium text-gray-800">将本次对话整理为文档？</div>
          <div className="mt-2 text-xs leading-5 text-gray-500">
            将基于当前会话的历史对话生成结构化文档，保存到文件库中。
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-lg px-3 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => setStep('save')}
              className="h-9 rounded-lg bg-green-500 px-3 text-xs font-medium text-white transition-colors hover:bg-green-600"
            >
              继续
            </button>
          </div>
        </div>
      )}

      {/* 步骤 2：选择保存位置 + 文件名 */}
      {step === 'save' && (
        <div
          className="flex w-[560px] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-gray-200/70 px-4 py-3">
            <span className="text-sm font-medium text-gray-800">选择保存位置</span>
            <button
              type="button"
              onClick={onClose}
              title="关闭"
              className="flex h-6 w-6 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* 左：文件夹树；右：面包屑 + 当前目录内容 */}
          <div className="flex min-h-0 flex-1">
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
              {tree.map((node) => (
                <FolderRow
                  key={node.id}
                  node={node}
                  depth={0}
                  currentId={currentId}
                  expanded={expanded}
                  onNavigate={navigateTo}
                />
              ))}
            </div>

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

              {/* 当前目录内容（子文件夹可点入，文件仅展示位置） */}
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
                      <div
                        key={node.id}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-gray-400"
                      >
                        <span className="w-3.5 shrink-0" />
                        <FileText className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-left">{node.name}</span>
                      </div>
                    )
                  )
                )}
              </div>
            </div>
          </div>

          {/* 文件名 + 目标路径预览 + 操作 */}
          <div className="border-t border-gray-200/70 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-xs text-gray-500">文件名</span>
              <input
                ref={inputRef}
                type="text"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmSave()
                }}
                placeholder="输入文件名"
                className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none transition-colors focus:border-green-500"
              />
            </div>
            <div className="mt-1.5 truncate text-xs text-gray-400">
              保存到：{currentId ? `${currentId}/${fileName.trim() || '…'}` : fileName.trim() || '…'}
            </div>
            {error && (
              <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-600">
                {error}
              </div>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-9 rounded-lg px-3 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmSave}
                className="h-9 rounded-lg bg-green-500 px-3 text-xs font-medium text-white transition-colors hover:bg-green-600"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 步骤 3：覆盖确认（同名文件已存在） */}
      {step === 'overwrite' && (
        <div
          className="w-80 rounded-xl border border-gray-200 bg-white p-5 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-sm font-medium text-gray-800">已存在同名文件，是否覆盖？</div>
          <div className="mt-2 text-xs leading-5 text-gray-500">「{pendingRelPath}」已存在，覆盖将替换原有内容。</div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-lg px-3 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => onSubmit(pendingRelPath)}
              className="h-9 rounded-lg bg-red-500 px-3 text-xs font-medium text-white transition-colors hover:bg-red-600"
            >
              覆盖
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
