import { useCallback, useEffect, useState } from 'react'

export interface UseKnowledge {
  /** sidecar 知识库服务状态（available/indexed/kbs 摘要） */
  status: KnowledgeStatus | null
  statusLoading: boolean
  /** 全部知识库列表 */
  kbs: KnowledgeBase[]
  kbsLoading: boolean
  selectedKbId: string | null
  selectedKb: KnowledgeBase | null
  /** 选中 KB 的文件列表 */
  kbFiles: KnowledgeFile[]
  filesLoading: boolean
  /** 正在更改（建/删/传/删文件任一在途）→ 驱动「正在更改」加载条 */
  mutating: boolean
  mutationError: string | null
  refresh: () => void
  selectKb: (id: string | null) => void
  createKb: (name: string) => Promise<void>
  deleteKb: (id: string) => Promise<void>
  refreshFiles: () => void
  uploadFiles: (files: KnowledgeUploadFile[]) => Promise<void>
  deleteFile: (rel: string) => Promise<void>
  clearMutationError: () => void
}

/**
 * 知识库管理器：自建 KB + 每 KB 独立文件/索引。
 * 所有「更改」操作（建/删/传/删文件）都视作「变更+重建」一体，经 runMutation 串行包裹，
 * 在途时置 mutating=true 供页面渲染「正在更改」加载条。
 */
export function useKnowledge(): UseKnowledge {
  const [status, setStatus] = useState<KnowledgeStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [kbs, setKbs] = useState<KnowledgeBase[]>([])
  const [kbsLoading, setKbsLoading] = useState(true)
  const [selectedKbId, setSelectedKbId] = useState<string | null>(null)
  const [kbFiles, setKbFiles] = useState<KnowledgeFile[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [filesTick, setFilesTick] = useState(0)
  const [mutating, setMutating] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)

  const loadKbs = useCallback((): void => {
    window.api.knowledge
      .kbs()
      .then((res) => setKbs(res.kbs ?? []))
      .catch((err: unknown) => {
        console.warn('获取知识库列表失败：', err)
        setKbs([])
      })
      .finally(() => setKbsLoading(false))
  }, [])

  // sidecar 就绪时拉一次状态与列表
  useEffect(() => {
    loadKbs()
    window.api.knowledge
      .status()
      .then((s) => setStatus(s))
      .catch((err: unknown) => {
        console.warn('获取知识库状态失败：', err)
        setStatus(null)
      })
      .finally(() => setStatusLoading(false))
    const offStatus = window.api.sidecar.onStatusChange((st) => {
      if (st === 'ready') loadKbs()
    })
    return () => {
      offStatus()
    }
  }, [loadKbs])

  // 选中 KB 变化 / refreshFiles 时加载其文件
  useEffect(() => {
    if (!selectedKbId) {
      setKbFiles([])
      return
    }
    let cancelled = false
    setFilesLoading(true)
    window.api.knowledge
      .listKbFiles(selectedKbId)
      .then((res) => {
        if (!cancelled) setKbFiles(res.files ?? [])
      })
      .catch((err: unknown) => {
        console.warn('获取知识库文件失败：', err)
        if (!cancelled) setKbFiles([])
      })
      .finally(() => {
        if (!cancelled) setFilesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedKbId, filesTick])

  /** 串行执行一次「更改」：置 mutating + 清错误，失败则记录 mutationError。 */
  const runMutation = useCallback(async (fn: () => Promise<void>): Promise<void> => {
    setMutating(true)
    setMutationError(null)
    try {
      await fn()
    } catch (err: unknown) {
      console.warn('知识库操作失败：', err)
      setMutationError(err instanceof Error ? err.message : String(err))
    } finally {
      setMutating(false)
    }
  }, [])

  const selectKb = useCallback((id: string | null): void => {
    setSelectedKbId(id)
  }, [])

  const refreshFiles = useCallback((): void => {
    setFilesTick((t) => t + 1)
  }, [])

  const createKb = useCallback(
    async (name: string): Promise<void> => {
      await runMutation(async () => {
        const res = await window.api.knowledge.createKb(name)
        loadKbs()
        // 新建后自动选中：右侧展开空详情面板
        if (res?.id) setSelectedKbId(res.id)
      })
    },
    [runMutation, loadKbs]
  )

  const deleteKb = useCallback(
    async (id: string): Promise<void> => {
      await runMutation(async () => {
        await window.api.knowledge.deleteKb(id)
        if (selectedKbId === id) setSelectedKbId(null)
        loadKbs()
      })
    },
    [runMutation, selectedKbId, loadKbs]
  )

  const uploadFiles = useCallback(
    async (files: KnowledgeUploadFile[]): Promise<void> => {
      if (!selectedKbId || files.length === 0) return
      await runMutation(async () => {
        await window.api.knowledge.uploadKbFiles({ kbId: selectedKbId, files })
        loadKbs()
        refreshFiles()
      })
    },
    [runMutation, selectedKbId, loadKbs, refreshFiles]
  )

  const deleteFile = useCallback(
    async (rel: string): Promise<void> => {
      if (!selectedKbId) return
      await runMutation(async () => {
        await window.api.knowledge.deleteKbFile({ kbId: selectedKbId, rel })
        loadKbs()
        refreshFiles()
      })
    },
    [runMutation, selectedKbId, loadKbs, refreshFiles]
  )

  const clearMutationError = useCallback((): void => setMutationError(null), [])

  const selectedKb = kbs.find((k) => k.id === selectedKbId) ?? null

  return {
    status,
    statusLoading,
    kbs,
    kbsLoading,
    selectedKbId,
    selectedKb,
    kbFiles,
    filesLoading,
    mutating,
    mutationError,
    refresh: loadKbs,
    selectKb,
    createKb,
    deleteKb,
    refreshFiles,
    uploadFiles,
    deleteFile,
    clearMutationError
  }
}
