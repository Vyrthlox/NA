import { type MouseEvent as ReactMouseEvent } from 'react'
import { ChevronRight, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/cn'

interface NavItemProps {
  label: string
  icon: LucideIcon
  active: boolean
  onClick: () => void
  /** 是否为可展开项（右侧显示展开箭头） */
  expandable?: boolean
  expanded?: boolean
  /** 右键菜单（如「文件夹」图标 → 新建文件夹）；须自行 preventDefault/stopPropagation */
  onContextMenu?: (e: ReactMouseEvent<HTMLButtonElement>) => void
}

export function NavItem({
  label,
  icon: Icon,
  active,
  onClick,
  expandable,
  expanded,
  onContextMenu
}: NavItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
        active
          ? 'bg-green-50 text-green-700' // 浅绿高亮
          : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
      )}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={active ? 2.2 : 1.8} />
      <span className="flex-1 text-left">{label}</span>
      {expandable && (
        <ChevronRight
          className={cn(
            'h-4 w-4 shrink-0 text-gray-400 transition-transform duration-150',
            expanded && 'rotate-90'
          )}
        />
      )}
    </button>
  )
}
