import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { readFile, rm } from 'fs/promises'
import { setTimeout as delay } from 'timers/promises'
import type { SidecarConfig } from './config'

export type SidecarStatus = 'starting' | 'ready' | 'stopped' | 'crashed' | 'failed'

export interface SidecarEndpoint {
  /** 如 http://127.0.0.1:54321 */
  baseUrl: string
  token: string
}

export interface SidecarStatusInfo {
  status: SidecarStatus
  ready: boolean
  baseUrl: string | null
  /** 连续重启次数（用于 UI 展示/诊断）。 */
  attempts: number
}

const MAX_BACKOFF_MS = 30_000

/**
 * Sidecar 进程生命周期管理者：「起停哨兵 + 接线员」。
 *
 * 职责：
 *  1. spawn  —— 启动 `python -m sidecar.app`（cwd=仓库根目录）
 *  2. 发现   —— 等待 data/sidecar.status.json 出现且 pid 匹配本次子进程，读出实际端口+token
 *  3. 健康   —— 轮询 GET /healthz 直到就绪
 *  4. 凭证   —— 持有 token，供 gateway（SSE 转发）发起带鉴权的请求
 *  5. 回收   —— 退出时优雅停子进程；process exit 时同步兜底
 *  6. 恢复   —— 崩溃后按指数退避重启
 *  7. 广播   —— emit 'status' 事件，主进程转发给 renderer
 */
export class SidecarManager extends EventEmitter {
  private child: ChildProcess | null = null
  private currentStatus: SidecarStatus = 'stopped'
  private endpoint: SidecarEndpoint | null = null
  private stopping = false
  private restartAttempts = 0

  constructor(private readonly config: SidecarConfig) {
    super()
  }

  get status(): SidecarStatus {
    return this.currentStatus
  }

  get isReady(): boolean {
    return this.currentStatus === 'ready'
  }

  getEndpoint(): SidecarEndpoint | null {
    return this.endpoint
  }

  statusInfo(): SidecarStatusInfo {
    return {
      status: this.currentStatus,
      ready: this.isReady,
      baseUrl: this.endpoint?.baseUrl ?? null,
      attempts: this.restartAttempts
    }
  }

  async start(): Promise<void> {
    if (this.child) return // 已在运行（starting/ready）
    this.stopping = false
    this.restartAttempts = 0
    this.setStatus('starting')
    await this.spawnChild()
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.endpoint = null
    this.setStatus('stopped')
    const child = this.child
    this.child = null
    if (child && child.exitCode === null && !child.killed) {
      child.kill() // Windows 下等价于终止子进程
      // 等它真正退出；3s 内没退出也不阻塞 app 退出
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        delay(3000)
      ])
    }
  }

  /** 同步杀子进程：供 process.on('exit') 这类无法 await 的路径兜底。 */
  killSync(): void {
    this.stopping = true
    this.child?.kill()
  }

  private setStatus(status: SidecarStatus): void {
    if (this.currentStatus === status) return
    this.currentStatus = status
    console.log(`[sidecar] 状态 -> ${status}`)
    this.emit('status', status)
  }

  private async spawnChild(): Promise<void> {
    // 清掉上一次运行的残留状态文件，避免读到过期端口
    await rm(this.config.statusFile, { force: true })

    const { python, args, repoRoot } = this.config
    console.log(`[sidecar] 启动 ${python} ${args.join(' ')} (cwd=${repoRoot})`)
    // PYTHONIOENCODING=utf-8：Windows 下 Python stdout 默认走 GBK，乱码；强制 UTF-8 便于透传排障
    // NA_SIDECAR_PARENT_PID：让 sidecar 侧起「父进程存活看门狗」，父进程被硬杀（Ctrl+C/taskkill /F）时自我回收，
    //   避免主进程强制退出后留下孤儿 sidecar。
    const child = spawn(python, args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        NA_SIDECAR_PARENT_PID: String(process.pid)
      }
    })
    this.child = child

    // sidecar 自己的日志直接透传到主进程输出，方便排障
    child.stdout?.on('data', (d) => process.stdout.write(`[sidecar:out] ${String(d)}`))
    child.stderr?.on('data', (d) => process.stderr.write(`[sidecar:err] ${String(d)}`))

    child.once('error', (err) => {
      // spawn 本身失败（如 python 找不到），不重启 —— 重启也没用
      console.error(`[sidecar] 生成进程失败: ${err.message}`)
      if (this.child === child) this.child = null
      this.setStatus('failed')
    })

    child.once('exit', (code, signal) => {
      console.log(`[sidecar] 进程退出 code=${code} signal=${signal}`)
      if (this.child === child) this.child = null
      this.endpoint = null
      if (this.stopping) {
        this.setStatus('stopped')
      } else {
        // 非主动停止 → 视为崩溃，按指数退避重启
        this.setStatus('crashed')
        this.scheduleRestart()
      }
    })

    await this.waitForReady(child)
  }

  private async waitForReady(child: ChildProcess): Promise<void> {
    // 1) 等状态文件出现且 pid 匹配本次子进程（防止读到残留）
    const spawnDeadline = Date.now() + this.config.spawnTimeoutMs
    while (Date.now() < spawnDeadline && this.child === child) {
      try {
        const raw = await readFile(this.config.statusFile, 'utf-8')
        const status = JSON.parse(raw) as { host?: string; port?: number; token?: string; pid?: number }
        if (status.pid !== child.pid || typeof status.port !== 'number' || !status.token) {
          await delay(this.config.pollIntervalMs)
          continue
        }
        this.endpoint = {
          baseUrl: `http://${status.host ?? '127.0.0.1'}:${status.port}`,
          token: status.token
        }
        break
      } catch {
        // 文件还没写出来 / 写了一半，继续等
        await delay(this.config.pollIntervalMs)
      }
    }
    if (!this.endpoint) {
      console.error('[sidecar] 等待状态文件超时')
      return this.fail(child)
    }

    // 2) 轮询 /healthz 直到通过
    console.log(`[sidecar] 状态文件已读取: ${this.endpoint.baseUrl}`)
    const healthDeadline = Date.now() + this.config.healthzTimeoutMs
    while (Date.now() < healthDeadline && this.child === child) {
      try {
        const res = await fetch(`${this.endpoint.baseUrl}/healthz`)
        if (res.ok) {
          console.log(`[sidecar] 就绪 ${this.endpoint.baseUrl}`)
          this.restartAttempts = 0
          this.setStatus('ready')
          return
        }
      } catch {
        // 尚未起好，继续
      }
      await delay(this.config.pollIntervalMs)
    }
    console.error('[sidecar] /healthz 超时未就绪')
    await this.fail(child)
  }

  /** 进程活着但不健康 → 杀掉以触发 exit → 走崩溃重启。 */
  private async fail(child: ChildProcess): Promise<void> {
    if (this.child === child && child.exitCode === null && !child.killed) {
      child.kill()
    }
  }

  private scheduleRestart(): void {
    this.restartAttempts++
    const backoff = Math.min(1000 * 2 ** (this.restartAttempts - 1), MAX_BACKOFF_MS)
    console.log(`[sidecar] 第 ${this.restartAttempts} 次崩溃，${backoff}ms 后重启`)
    setTimeout(() => {
      if (!this.stopping) void this.spawnChild()
    }, backoff)
  }
}
