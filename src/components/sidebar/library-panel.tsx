import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ChevronRight, FilePlus, FileText, Folder, FolderPlus, Trash2 } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useLibrary } from '../../lib/use-library'
import { displayFileName } from '../../lib/library-name'

/** 对外句柄：侧边栏「文件夹」导航图标右键时调用，打开根级菜单 */
export interface LibraryPanelHandle {
  openRootMenu: (x: number, y: number) => void
}

/** 右键菜单状态：kind=root 来自「文件夹」图标；folder/file 来自树内节点 */
interface MenuState {
  kind: 'root' | 'folder' | 'file'
  node?: LibraryNode
  x: number
  y: number
}

/** 命名浮层：新建目标（parent='' 表示根） */
interface NamingState {
  kind: 'folder' | 'file'
  parent: string
}

/** 删除确认浮层：目标节点 */
interface ConfirmingState {
  kind: 'folder' | 'file'
  node: LibraryNode
}

/** 面板 props：点击文件 / 新建文件成功后打开富文本编辑器；删除打开中的文件/文件夹时传 null 关闭 */
interface LibraryPanelProps {
  /** 当前打开的文件（判断删除后是否要关闭编辑器） */
  openFile?: LibraryNode | null
  onOpenFile?: (node: LibraryNode | null) => void
}

/** 菜单宽高（clamp 防溢出视口）：w-36≈144 + 右侧余量；文件夹 3 项，根/文件 1 项 */
function clampMenuPos(x: number, y: number, kind: MenuState['kind']): { x: number; y: number } {
  const h = kind === 'folder' ? 132 : 48
  return {
    x: Math.min(x, Math.max(0, window.innerWidth - 152)),
    y: Math.min(y, Math.max(0, window.innerHeight - h))
  }
}

interface TreeNodeProps {
  node: LibraryNode
  depth: number
  expanded: Record<string, boolean>
  onToggle: (id: string) => void
  onContextMenu: (node: LibraryNode, x: number, y: number) => void
  /** 点击文件：在主区打开富文本编辑器 */
  onOpen: (node: LibraryNode) => void
}

/** 单行节点：文件夹（可展开）+ 文件；右键交给上层开菜单 */
function TreeNode({ node, depth, expanded, onToggle, onContextMenu, onOpen }: TreeNodeProps) {
  const isFolder = node.type === 'folder'
  const isOpen = isFolder && !!expanded[node.id]
  return (
    <div>
      <button
        type="button"
        onClick={isFolder ? () => onToggle(node.id) : () => onOpen(node)}
        onContextMenu={(e) => {
          e.preventDefault()
          // stopPropagation：避免继续冒泡到 window 的 contextmenu 关闭监听器（开→立即关）
          e.stopPropagation()
          onContextMenu(node, e.clientX, e.clientY)
        }}
        title={node.name}
        className="flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm text-gray-700 transition-colors hover:bg-gray-50"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        {isFolder ? (
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform duration-150',
              isOpen && 'rotate-90'
            )}
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {isFolder ? (
          <Folder className="h-4 w-4 shrink-0 text-amber-500" />
        ) : (
          <FileText className="h-4 w-4 shrink-0 text-gray-400" />
        )}
        <span className="min-w-0 flex-1 truncate text-left">{isFolder ? node.name : displayFileName(node.name)}</span>
      </button>
      {isFolder && isOpen && (node.children?.length ?? 0) > 0 && (
        <div>
          {node.children?.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onContextMenu={onContextMenu}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 「文件夹」文件树面板：递归树 + 右键菜单 + 命名浮层 + 删除确认浮层。
 * 常驻挂载（折叠时由父级隐藏），保证折叠态右键「文件夹」图标仍能建根文件夹。
 */
export const LibraryPanel = forwardRef<LibraryPanelHandle, LibraryPanelProps>(function LibraryPanel(
  { openFile, onOpenFile },
  ref
) {
  const { tree, loading, createFolder, createFile, deleteFolder, deleteFile } = useLibrary()
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [naming, setNaming] = useState<NamingState | null>(null)
  const [confirming, setConfirming] = useState<ConfirmingState | null>(null)
  const [defaultName, setDefaultName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const toggleExpanded = useCallback((id: string): void => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  // 根级菜单（侧边栏「文件夹」图标右键）
  const openRootMenu = useCallback((x: number, y: number): void => {
    setMenu({ kind: 'root', x: clampMenuPos(x, y, 'root').x, y: clampMenuPos(x, y, 'root').y })
  }, [])
  useImperativeHandle(ref, () => ({ openRootMenu }), [openRootMenu])

  // 树内节点右键
  const openNodeMenu = useCallback((node: LibraryNode, x: number, y: number): void => {
    const pos = clampMenuPos(x, y, node.type)
    setMenu({ kind: node.type, node, x: pos.x, y: pos.y })
  }, [])

  // 关闭右键菜单：点击任意处 / 再次右键 / Escape / 滚动（照 recent-conversations）
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

  const closeNaming = useCallback((): void => {
    setNaming(null)
    setCreateError(null)
  }, [])

  // 命名浮层确认
  const submitNaming = useCallback((): void => {
    if (!naming) return
    const value = inputRef.current?.value.trim() ?? ''
    if (!value) {
      setCreateError('名称不能为空')
      return
    }
    setCreateError(null)
    const op = naming.kind === 'folder' ? createFolder(naming.parent, value) : createFile(naming.parent, value)
    op.then((node) => {
      setNaming(null)
      // 新建在父文件夹内 → 展开父文件夹让新条目可见
      if (node && naming.parent) setExpanded((prev) => ({ ...prev, [naming.parent]: true }))
      // 新建文件成功后直接打开编辑器（贴日常学习场景）
      if (node && naming.kind === 'file') onOpenFile?.(node)
    }).catch((err: unknown) => {
      setCreateError(err instanceof Error ? err.message : String(err))
    })
  }, [naming, createFolder, createFile])

  // 菜单「新建」→ 打开命名浮层
  const requestCreate = useCallback((kind: 'folder' | 'file', parent: string): void => {
    setMenu(null)
    setCreateError(null)
    setDefaultName(kind === 'folder' ? '新建文件夹' : '新建文件')
    setNaming({ kind, parent })
  }, [])

  // 菜单「删除」→ 打开确认浮层
  const requestDelete = useCallback((node: LibraryNode): void => {
    setMenu(null)
    setDeleteError(null)
    setConfirming({ kind: node.type, node })
  }, [])

  const closeConfirm = useCallback((): void => {
    setConfirming(null)
    setDeleteError(null)
  }, [])

  // 确认删除：真正执行，失败错误条显示在面板顶部
  const confirmDelete = useCallback((): void => {
    if (!confirming) return
    const { kind, node } = confirming
    setConfirming(null)
    setDeleteError(null)
    const op = kind === 'folder' ? deleteFolder(node.id) : deleteFile(node.id)
    op.then(() => {
      // 删除的节点若包含当前打开的文件，自动关闭编辑器，避免残留空编辑窗
      if (openFile && (openFile.id === node.id || openFile.id.startsWith(`${node.id}/`))) {
        onOpenFile?.(null)
      }
    }).catch((err: unknown) => {
      setDeleteError(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    })
  }, [confirming, deleteFolder, deleteFile, openFile, onOpenFile])

  // 命名浮层输入框：挂载后全选默认名（便于直接输入覆盖）
  useEffect(() => {
    if (naming) inputRef.current?.select()
  }, [naming])

  // 关确认浮层：Escape
  useEffect(() => {
    if (!confirming) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeConfirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirming, closeConfirm])

  return (
    <div className="mt-1 flex min-h-0 flex-1 flex-col">
      {/* 删除失败错误条 */}
      {deleteError && (
        <div className="mx-2 mt-1 rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-600">
          {deleteError}
        </div>
      )}

      {/* 树 / 加载 / 空态 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading ? (
          <div className="rounded-md px-3 py-2 pl-10 text-xs text-gray-400">加载中…</div>
        ) : tree.length === 0 ? (
          <div className="rounded-md px-3 py-2 pl-10 text-xs text-gray-400">暂无文件夹</div>
        ) : (
          <div className="mt-0.5">
            {tree.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                depth={0}
                expanded={expanded}
                onToggle={toggleExpanded}
                onContextMenu={openNodeMenu}
                onOpen={(n) => onOpenFile?.(n)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 右键菜单：按 kind 显示对应选项 */}
      {menu && (
        <div
          className="fixed z-50 w-36 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.kind !== 'file' && (
            <button
              type="button"
              onClick={() => requestCreate('folder', menu.node?.id ?? '')}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50"
            >
              <FolderPlus className="h-3.5 w-3.5 text-gray-400" />
              新建文件夹
            </button>
          )}
          {menu.kind === 'folder' && (
            <button
              type="button"
              onClick={() => requestCreate('file', menu.node?.id ?? '')}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50"
            >
              <FilePlus className="h-3.5 w-3.5 text-gray-400" />
              新建文件
            </button>
          )}
          {menu.kind !== 'root' && menu.node && (
            <button
              type="button"
              onClick={() => requestDelete(menu.node!)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 transition-colors hover:bg-red-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {menu.kind === 'folder' ? '删除文件夹' : '删除文件'}
            </button>
          )}
        </div>
      )}

      {/* 命名浮层（自绘，替代 window.prompt） */}
      {naming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={closeNaming}>
          <div
            className="w-80 rounded-xl border border-gray-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium text-gray-800">
              {naming.kind === 'folder' ? '新建文件夹' : '新建文件'}
            </div>
            <div className="mt-1 text-xs leading-5 text-gray-400">
              {naming.kind === 'folder'
                ? '将在当前文件夹下新建子文件夹'
                : '将保存为富文本笔记'}
            </div>
            <input
              ref={inputRef}
              type="text"
              autoFocus
              defaultValue={defaultName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitNaming()
                else if (e.key === 'Escape') closeNaming()
              }}
              placeholder={naming.kind === 'folder' ? '文件夹名称' : '文件名'}
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
                onClick={closeNaming}
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

      {/* 删除确认浮层（自绘，替代 window.confirm） */}
      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={closeConfirm}>
          <div
            className="w-80 rounded-xl border border-gray-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium text-gray-800">
              {confirming.kind === 'folder' ? '删除该文件夹？' : '删除该文件？'}
            </div>
            <div className="mt-2 text-xs leading-5 text-gray-500">
              「{confirming.node.name}」
              {confirming.kind === 'folder' ? '将连同其中文件和子文件夹一并删除，' : ''}
              此操作不可恢复。
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeConfirm}
                className="h-9 rounded-lg px-3 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                className="h-9 rounded-lg bg-red-500 px-3 text-xs font-medium text-white transition-colors hover:bg-red-600"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})
