import { Folder, LibraryBig, Sparkles, type LucideIcon } from 'lucide-react'

export type NavKey = 'na' | 'knowledge' | 'notebook'

export interface NavItemConfig {
  key: NavKey
  label: string
  icon: LucideIcon
}

// 严格按用户指定顺序：NA → 知识库 → 文件夹，不额外添加菜单项
export const NAV_ITEMS: NavItemConfig[] = [
  { key: 'na', label: 'NA', icon: Sparkles },
  { key: 'knowledge', label: '知识库', icon: LibraryBig },
  { key: 'notebook', label: '文件夹', icon: Folder }
]
