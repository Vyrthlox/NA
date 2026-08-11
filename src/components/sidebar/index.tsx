import { useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { NavItem } from './nav-item'
import { NAV_ITEMS, type NavKey } from './nav-items'
import { LibraryPanel, type LibraryPanelHandle } from './library-panel'
import { cn } from '../../lib/cn'

interface SidebarProps {
  active: NavKey
  onSelect: (key: NavKey) => void
  /** 折叠状态：true 时侧边栏向左侧边框收起 */
  collapsed: boolean
  onToggleCollapse: () => void
  /** 当前打开的文件（用于删除时判断是否需要关闭编辑器） */
  openFile?: LibraryNode | null
  /** 点击文件 / 新建文件时打开富文本编辑器；传 null 关闭当前编辑器 */
  onOpenFile?: (node: LibraryNode | null) => void
}

export { type NavKey } from './nav-items'

export default function Sidebar({
  active,
  onSelect,
  collapsed,
  onToggleCollapse,
  openFile,
  onOpenFile
}: SidebarProps) {
  const [notebookExpanded, setNotebookExpanded] = useState(false)
  // 文件库面板常驻挂载（折叠时仅隐藏），折叠态右键「文件夹」图标仍能建根文件夹
  const libraryPanelRef = useRef<LibraryPanelHandle>(null)

  const handleSelect = (key: NavKey): void => {
    onSelect(key)
    // 切换到其他模块时收起笔记本列表
    if (key !== 'notebook') setNotebookExpanded(false)
  }

  const toggleNotebook = (): void => {
    onSelect('notebook')
    setNotebookExpanded((v) => !v)
  }

  return (
    <div className="flex h-full shrink-0">
      <aside
        className={cn(
          'overflow-hidden border-r border-gray-200/70 bg-white transition-[width] duration-300 ease-in-out',
          collapsed ? 'w-0' : 'w-56'
        )}
      >
        <div className="flex h-full w-56 flex-col">
          {/* 品牌区：Logo.png（蓝紫渐变「NA」字标） */}
          <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-gray-100 px-4">
            <img src="./Logo.png" alt="NA" className="h-7 w-7 rounded-md object-contain" />
            <span className="text-sm font-semibold tracking-wide text-gray-800">NA</span>
          </div>

          {/* 垂直导航：NA → 知识库 → 文件夹（可展开） */}
          <nav className="flex flex-1 flex-col space-y-1 p-2">
            {NAV_ITEMS.map((item) =>
              item.key === 'notebook' ? (
                <div key={item.key} className="flex min-h-0 flex-1 flex-col">
                  <NavItem
                    label={item.label}
                    icon={item.icon}
                    active={active === item.key}
                    expandable
                    expanded={notebookExpanded}
                    onClick={toggleNotebook}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      // stopPropagation：避免冒泡到 window 的 contextmenu 关闭监听器（开→立即关）
                      e.stopPropagation()
                      libraryPanelRef.current?.openRootMenu(e.clientX, e.clientY)
                    }}
                  />
                  {/* 常驻挂载，折叠时仅隐藏：保证折叠态右键「文件夹」图标仍可用 */}
                  <div className={cn('flex min-h-0 flex-1 flex-col', !notebookExpanded && 'hidden')}>
                    <LibraryPanel ref={libraryPanelRef} openFile={openFile} onOpenFile={onOpenFile} />
                  </div>
                </div>
              ) : (
                <NavItem
                  key={item.key}
                  label={item.label}
                  icon={item.icon}
                  active={active === item.key}
                  onClick={() => handleSelect(item.key)}
                />
              )
            )}
          </nav>
        </div>
      </aside>

      {/* 折叠开关：常驻于侧边栏右缘（折叠后位于内容区左边缘） */}
      <button
        type="button"
        onClick={onToggleCollapse}
        title={collapsed ? '展开左侧边栏' : '折叠左侧边栏'}
        className="z-10 flex h-20 w-5 shrink-0 items-center justify-center self-center rounded-r-md border border-l-0 border-gray-200/70 bg-white text-gray-400 shadow-sm transition-colors hover:bg-gray-50 hover:text-gray-600"
      >
        {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
      </button>
    </div>
  )
}
