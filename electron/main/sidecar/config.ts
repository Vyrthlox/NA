import { join, resolve } from 'path'

/**
 * dev 构建输出布局：out/main/index.js → 仓库根目录是 ../../。
 * 打包后（sidecar 改成可执行文件时）这里需要按生产布局重写。
 */
const DEV_REPO_ROOT = resolve(__dirname, '../..')

/** 仓库根目录（dev 布局推导），供文件库等需要定位 data/ 的模块复用 */
export const REPO_ROOT = DEV_REPO_ROOT

export interface SidecarConfigOptions {
  /** 仓库根目录，sidecar 的 cwd（也是 data/ 的父目录）。默认按 dev 布局推导。 */
  repoRoot?: string
  /** Python 可执行文件，默认取 PATH 上的 python，可用 NA_SIDECAR_PYTHON 覆盖。 */
  python?: string
  /** 传给 python 的参数。默认 `-m sidecar.app --port 0`（随机端口）。 */
  args?: string[]
  /** 端口覆盖，等价于往 args 里塞 --port。 */
  port?: number
  /** sidecar 启动后写入实际端口+token 的状态文件路径。 */
  statusFile?: string
  /** 等待状态文件出现的最长时间（含重启）。 */
  spawnTimeoutMs?: number
  /** 状态文件就绪后，等待 /healthz 通过的最长时间。 */
  healthzTimeoutMs?: number
  /** 轮询 /healthz 与状态文件的间隔。 */
  pollIntervalMs?: number
}

export class SidecarConfig {
  readonly repoRoot: string
  readonly python: string
  readonly args: string[]
  readonly statusFile: string
  readonly spawnTimeoutMs: number
  readonly healthzTimeoutMs: number
  readonly pollIntervalMs: number

  constructor(opts: SidecarConfigOptions = {}) {
    this.repoRoot = opts.repoRoot ?? DEV_REPO_ROOT
    this.python = opts.python ?? process.env['NA_SIDECAR_PYTHON'] ?? 'python'
    const port = opts.port ?? Number(process.env['NA_SIDECAR_PORT'] ?? '0')
    this.args = opts.args ?? ['-m', 'sidecar.app', '--port', String(port)]
    this.statusFile = opts.statusFile ?? join(this.repoRoot, 'data', 'sidecar.status.json')
    this.spawnTimeoutMs = opts.spawnTimeoutMs ?? 60_000
    this.healthzTimeoutMs = opts.healthzTimeoutMs ?? 30_000
    this.pollIntervalMs = opts.pollIntervalMs ?? 500
  }
}
