import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Image as ImageIcon } from 'lucide-react'
import { cn } from '../../lib/cn'

/** 模型提供商：deepseek 文本 / qwen 视觉（图片能力） */
export type ProviderKey = 'deepseek' | 'qwen'
/** 深度档位：fast 快速（低价模型）/ deep 深度（更强模型） */
export type DepthKey = 'fast' | 'deep'

export interface ModelChoice {
  provider: ProviderKey
  depth: DepthKey
}

const PROVIDERS: { key: ProviderKey; label: string; badge: string; badgeClass: string }[] = [
  { key: 'deepseek', label: 'DeepSeek', badge: 'DS', badgeClass: 'text-green-600' },
  { key: 'qwen', label: 'Qwen', badge: 'QW', badgeClass: 'text-violet-600' }
]

const DEPTHS: { key: DepthKey; label: string; hint: string }[] = [
  { key: 'fast', label: '快速', hint: '低价模型' },
  { key: 'deep', label: '深度', hint: '更强模型' }
]

interface ModelSelectorProps {
  value: ModelChoice
  onChange: (choice: ModelChoice) => void
  /** 当前挂有图片附件：带图消息实际固定走 Qwen·快速（视觉模型），展示提示 */
  hasImages?: boolean
}

/** 模型选择下拉（受控组件）：模型提供商（DeepSeek/Qwen）× 深度档位（快速/深度） */
export function ModelSelector({ value, onChange, hasImages = false }: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 点击外部时收起
  useEffect(() => {
    const onPointerDown = (e: MouseEvent): void => {
      if (open && rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const provider = PROVIDERS.find((p) => p.key === value.provider)!
  const depth = DEPTHS.find((d) => d.key === value.depth)!

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-9 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50',
          open && 'bg-gray-50 text-gray-800'
        )}
      >
        <span className={cn('font-semibold', provider.badgeClass)}>{provider.badge}</span>
        {provider.label}
        <span className="text-gray-300">·</span>
        {depth.label}
        {hasImages && <ImageIcon className="h-3 w-3 text-violet-500" />}
        <ChevronDown
          className={cn('h-3.5 w-3.5 text-gray-400 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-44 overflow-hidden rounded-lg border border-gray-100 bg-white py-1 shadow-lg">
          <div className="px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-400">模型</div>
          {PROVIDERS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => onChange({ ...value, provider: p.key })}
              className={cn(
                'flex w-full items-center justify-between px-3 py-1.5 text-xs transition-colors',
                p.key === value.provider
                  ? 'text-green-700'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              )}
            >
              <span className="flex items-center gap-1.5">
                <span className={cn('font-semibold', p.badgeClass)}>{p.badge}</span>
                {p.label}
              </span>
              {p.key === value.provider && <Check className="h-3.5 w-3.5" />}
            </button>
          ))}

          <div className="mt-1 border-t border-gray-100" />
          <div className="px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-400">档位</div>
          {DEPTHS.map((d) => (
            <button
              key={d.key}
              type="button"
              onClick={() => onChange({ ...value, depth: d.key })}
              className={cn(
                'flex w-full items-center justify-between px-3 py-1.5 text-xs transition-colors',
                d.key === value.depth
                  ? 'text-green-700'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              )}
            >
              <span>
                {d.label}
                <span className="ml-1 text-[10px] text-gray-400">{d.hint}</span>
              </span>
              {d.key === value.depth && <Check className="h-3.5 w-3.5" />}
            </button>
          ))}

          {hasImages && (
            <div className="mt-1 flex items-center gap-1 border-t border-gray-100 px-3 py-1.5 text-[10px] text-violet-500">
              <ImageIcon className="h-3 w-3 shrink-0" />
              含图片消息 → Qwen · 快速
            </div>
          )}
        </div>
      )}
    </div>
  )
}
