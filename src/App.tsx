import { useEffect, useState } from 'react'
import Sidebar, { type NavKey } from './components/sidebar'
import ChatPage from './components/na/chat-page'
import KnowledgePage from './components/knowledge/knowledge-page'
import NoteEditor from './components/library/note-editor'

export default function App() {
  const [active, setActive] = useState<NavKey>('na')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // 当前打开的文件（富文本笔记）：非空时主区显示编辑器
  const [openFile, setOpenFile] = useState<LibraryNode | null>(null)

  // 切换到其他模块时关闭已打开的文件编辑器（切文件/点「文件夹」展开树不触发 active 变化，编辑器保留）
  useEffect(() => {
    setOpenFile(null)
  }, [active])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#f7f8fa] text-gray-800">
      <Sidebar
        active={active}
        onSelect={setActive}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
        openFile={openFile}
        onOpenFile={setOpenFile}
      />
      {/* 右侧主内容区：已打开文件优先显示编辑器，否则按导航切换 */}
      <main className="flex flex-1 overflow-auto bg-[#f7f8fa]">
        {openFile ? (
          <NoteEditor key={openFile.id} node={openFile} onClose={() => setOpenFile(null)} />
        ) : (
          <>
            {active === 'na' && <ChatPage />}
            {active === 'knowledge' && <KnowledgePage />}
          </>
        )}
      </main>
    </div>
  )
}
