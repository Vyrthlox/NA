import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { promises as fsp } from 'fs'
import { REPO_ROOT } from '../sidecar/config'

/**
 * 文件库：真实文件系统上的「文件夹/文件」树。
 * 根 = data/library/（仓库根下，与 sidecar 的 data/ 同级，gitignored）。
 * 文件夹 = 目录；文件 = 富文本片段（.html，新建时自动补后缀），内容为 TipTap/HTML 片段。
 * 所有对外路径用 posix 风格相对路径（如 "设计文档/需求.html"），与 renderer 端 id 一致。
 */

export interface LibraryNode {
  /** 相对根的 posix 路径，如 "设计文档"、"设计文档/需求.md" */
  id: string
  name: string
  type: 'folder' | 'file'
  /** 仅文件夹有；排序：文件夹在前，各自按中文名称排序 */
  children?: LibraryNode[]
}

const ROOT = join(REPO_ROOT, 'data', 'library')

/** Windows 文件名非法字符（含 / 分隔符与 \\） */
const INVALID_NAME_CHARS = /[\\/:*?"<>|]/

/** 名称校验：去空白、拒非法字符与 ..、拒以空格/点结尾；返回清洗后的名称 */
function assertSafeName(name: string): string {
  const n = name.trim()
  if (!n) throw new Error('名称不能为空')
  if (n === '.' || n === '..') throw new Error('名称无效')
  if (INVALID_NAME_CHARS.test(n)) throw new Error('名称不能包含 \\ / : * ? " < > | 等字符')
  if (n.endsWith('.') || n.endsWith(' ')) throw new Error('名称不能以空格或点结尾')
  return n
}

/** 把相对路径解析到 ROOT 内；.. 逃逸/绝对路径/跨盘符抛错（防路径穿越） */
function resolveInRoot(relPath: string): string {
  const abs = resolve(ROOT, relPath)
  const rel = relative(ROOT, abs)
  // 同盘下 .. 逃逸以 '..' 开头；跨盘（Windows）relative 返回绝对路径
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('非法路径')
  }
  return abs
}

/** 重名唯一化：存在则依次尝试「name (2)」「name (3)」… */
async function uniquePath(dir: string, name: string): Promise<string> {
  if (!(await pathExists(join(dir, name)))) return join(dir, name)
  for (let n = 2; ; n++) {
    const candidate = join(dir, `${name} (${n})`)
    if (!(await pathExists(candidate))) return candidate
  }
}

/** 路径是否存在（access 不抛错即存在） */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

/** 递归读取目录树；根目录不存在时返回空 */
async function walk(absDir: string, relPrefix: string): Promise<LibraryNode[]> {
  let entries
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const nodes: LibraryNode[] = []
  for (const e of entries) {
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name
    if (e.isDirectory()) {
      const children = await walk(join(absDir, e.name), rel)
      nodes.push({ id: rel, name: e.name, type: 'folder', children })
    } else if (e.isFile()) {
      nodes.push({ id: rel, name: e.name, type: 'file' })
    }
    // 其余类型（符号链接/设备等）忽略
  }
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
  return nodes
}

/** 列出整棵文件树（根级） */
export async function list(): Promise<LibraryNode[]> {
  return walk(ROOT, '')
}

/** 在 parent 下新建文件夹；parent='' 表示根。返回新节点 */
export async function createFolder(parent: string, name: string): Promise<LibraryNode> {
  const safeName = assertSafeName(name)
  const parentAbs = resolveInRoot(parent)
  const target = await uniquePath(parentAbs, safeName)
  await fsp.mkdir(target, { recursive: true })
  const dirName = basename(target)
  return { id: parent ? `${parent}/${dirName}` : dirName, name: dirName, type: 'folder', children: [] }
}

/** 在 parent 下新建文件；自动补 .html 后缀（富文本片段）。返回新节点 */
export async function createFile(parent: string, name: string): Promise<LibraryNode> {
  let base = assertSafeName(name)
  if (!base.toLowerCase().endsWith('.html')) base += '.html'
  const parentAbs = resolveInRoot(parent)
  const target = await uniquePath(parentAbs, base)
  await fsp.writeFile(target, '<p></p>\n', 'utf8')
  const fileName = basename(target)
  return { id: parent ? `${parent}/${fileName}` : fileName, name: fileName, type: 'file' }
}

/** 读取文件内容（utf8 文本）。相对路径须落在 ROOT 内，否则抛错 */
export async function readFile(relPath: string): Promise<string> {
  const abs = resolveInRoot(relPath)
  const st = await fsp.stat(abs)
  if (!st.isFile()) throw new Error('目标不是文件')
  return fsp.readFile(abs, 'utf8')
}

/** 写入文件内容（utf8 文本）。目标须是已存在的文件，相对路径须落在 ROOT 内 */
export async function writeFile(relPath: string, content: string): Promise<void> {
  if (typeof content !== 'string') throw new Error('内容格式无效')
  const abs = resolveInRoot(relPath)
  const st = await fsp.stat(abs)
  if (!st.isFile()) throw new Error('目标不是文件')
  await fsp.writeFile(abs, content, 'utf8')
}

/**
 * 写入整理文档（创建或覆盖，utf8 文本）：
 * 与 writeFile 不同，目标不要求已存在——用户选定路径后自动创建父目录并写文件；
 * 扩展名由调用方决定（AI 整理的富文本文档默认 .html）。相对路径须落在 ROOT 内。
 */
export async function writeDocument(
  relPath: string,
  content: string
): Promise<{ ok: boolean; relPath: string; created: boolean }> {
  if (typeof content !== 'string') throw new Error('内容格式无效')
  const abs = resolveInRoot(relPath)
  const created = !(await pathExists(abs))
  await fsp.mkdir(dirname(abs), { recursive: true })
  await fsp.writeFile(abs, content, 'utf8')
  return { ok: true, relPath, created }
}

/** 递归删除文件夹（含其中全部内容） */
export async function deleteFolder(relPath: string): Promise<void> {
  const abs = resolveInRoot(relPath)
  if (abs === ROOT) throw new Error('不能删除根文件夹')
  const st = await fsp.stat(abs)
  if (!st.isDirectory()) throw new Error('目标不是文件夹')
  await fsp.rm(abs, { recursive: true, force: true })
}

/** 删除单个文件 */
export async function deleteFile(relPath: string): Promise<void> {
  const abs = resolveInRoot(relPath)
  const st = await fsp.stat(abs)
  if (!st.isFile()) throw new Error('目标不是文件')
  await fsp.unlink(abs)
}
