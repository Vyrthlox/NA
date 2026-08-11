import { useCallback, useEffect, useState } from 'react'

export interface UseLibrary {
  /** 文件树根级节点（根级为文件夹；文件夹内含文件/子文件夹） */
  tree: LibraryNode[]
  loading: boolean
  /** 拉取最新树（挂载时自动执行；每次增删后由操作函数内部触发） */
  refresh: () => void
  /** 新建文件夹；parent='' 表示根。成功返回新节点 */
  createFolder: (parent: string, name: string) => Promise<LibraryNode | null>
  /** 新建文件（自动补 .md）；parent 为父文件夹相对路径。成功返回新节点 */
  createFile: (parent: string, name: string) => Promise<LibraryNode | null>
  /** 递归删除文件夹（含其中全部内容） */
  deleteFolder: (relPath: string) => Promise<void>
  /** 删除单个文件 */
  deleteFile: (relPath: string) => Promise<void>
  /** 读取文件内容（utf8 文本，供编辑器打开） */
  readFile: (relPath: string) => Promise<string>
  /** 写入文件内容（utf8 文本，供编辑器自动保存） */
  writeFile: (relPath: string, content: string) => Promise<void>
}

/** 文件库状态：持有 data/library/ 树，所有增删经 IPC 落真实文件系统后刷新 */
export function useLibrary(): UseLibrary {
  const [tree, setTree] = useState<LibraryNode[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback((): void => {
    window.api.library
      .list()
      .then((data) => setTree(data?.tree ?? []))
      .catch((err: unknown) => {
        console.warn('加载文件库失败：', err)
        setTree([])
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const createFolder = useCallback(
    async (parent: string, name: string): Promise<LibraryNode | null> => {
      const res = await window.api.library.createFolder({ parent, name })
      refresh()
      return res.node
    },
    [refresh]
  )

  const createFile = useCallback(
    async (parent: string, name: string): Promise<LibraryNode | null> => {
      const res = await window.api.library.createFile({ parent, name })
      refresh()
      return res.node
    },
    [refresh]
  )

  const deleteFolder = useCallback(
    async (relPath: string): Promise<void> => {
      await window.api.library.deleteFolder(relPath)
      refresh()
    },
    [refresh]
  )

  const deleteFile = useCallback(
    async (relPath: string): Promise<void> => {
      await window.api.library.deleteFile(relPath)
      refresh()
    },
    [refresh]
  )

  // 读写透传（编辑器用；保存不刷树，避免打断编辑）
  const readFile = useCallback(async (relPath: string): Promise<string> => {
    const res = await window.api.library.readFile(relPath)
    return res.content
  }, [])

  const writeFile = useCallback(
    async (relPath: string, content: string): Promise<void> => {
      await window.api.library.writeFile({ relPath, content })
    },
    []
  )

  return { tree, loading, refresh, createFolder, createFile, deleteFolder, deleteFile, readFile, writeFile }
}
