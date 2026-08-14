// CDP 驱动 NA 新知识库 UI 冒烟（2026-08-14 增强：真实可信鼠标事件 + 格式白名单）：
//   整页刷新对齐状态 → 知识库页创建 KB → 【真实鼠标点击】上传菜单 → 断言菜单项触发
//   file input.click()（Electron 无 fileChooser 拦截，对话框由 Chromium 保证）
//   → 注入文件上传（html+txt）→ 注入 .exe 断言「已跳过」提示 → 搜索过滤 → 切到 AI 对话
//   → 开「基于知识库」选库提问 → 断言引用 chips → 回归普通对话流式 → 回知识库右键删除 KB（清理）。
// 注意：脚本会给 file input 的 click() 打录制补丁（抑制自动化期间的原生对话框）；
//       冒烟结束后应重启/刷新应用再手动使用上传。
// 用法: node temp/cdp_knowledge.mjs <wsUrl>
// 启动: npm run dev -- -- --remote-debugging-port=9333  (curl http://127.0.0.1:9333/json/list)
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const wsUrl = process.argv[2]
if (!wsUrl) {
  console.error('usage: node temp/cdp_knowledge.mjs <webSocketDebuggerUrl>')
  process.exit(1)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 上传的测试文件（中文文件名验证真实客户端 UTF-8 路径）
const UPLOAD_PATH = path.join(__dirname, 'smoke', '光锥笔记.html')
const TXT_UPLOAD_PATH = path.join(__dirname, 'smoke', '格式说明.txt')
const BAD_UPLOAD_PATH = path.join(__dirname, 'smoke', '跳过测试.exe')
const KB_NAME = '冒烟测试库'
const QUERY = 'RAG 检索是怎么做的？'

const ws = new WebSocket(wsUrl)
let seq = 0
const pending = new Map()

function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
  }
}

/** 真实可信鼠标点击（Input.dispatchMouseEvent）：走用户激活路径，等价真人点击。 */
async function realClick(selector) {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (!box) throw new Error(`realClick: 未找到 ${selector}`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
}

/** 按文本真实点击菜单项（浮层按钮无稳定选择器时用）。 */
async function realClickByText(text) {
  const box = await evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (!box) throw new Error(`realClickByText: 未找到「${text}」`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('evaluate error: ' + JSON.stringify(r.exceptionDetails))
  return r.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(desc, fn, timeoutMs = 20000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch { /* keep polling */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('TIMEOUT waiting for ' + desc)
    await sleep(500)
  }
}

// 点击文本完全等于 label 的 nav 按钮（sidebar nav-item 的 textContent 即 label）
const clickNav = (label) => evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)})
  if (!b) return false
  b.click()
  return true
})()`)

ws.onopen = async () => {
  try {
    await send('Runtime.enable')
    await send('Page.enable')
    await send('DOM.enable')

    // 先整页刷新：renderer 的 KB 列表在挂载时从 sidecar 拉取，刷新可与服务器状态对齐，
    // 避免带外（API/上次失败残留）删除 KB 导致的前后端状态漂移。
    await send('Page.reload')
    await waitFor('刷新后首屏输入框', () =>
      evaluate(`!!document.querySelector('textarea')`), 30000)

    const doc = await send('DOM.getDocument')
    const rootNodeId = doc.root.nodeId

    // 1) 知识库页：点 nav → 点 [+ 新建] → 命名模态 → 创建
    await waitFor('知识库 nav', () => clickNav('知识库'))
    await waitFor('创建知识库按钮', () =>
      evaluate(`!!document.querySelector('button[title="创建知识库"]')`)
    )
    await evaluate(`document.querySelector('button[title="创建知识库"]').click(); true`)
    await waitFor('命名模态输入框', () =>
      evaluate(`!!document.querySelector('input[placeholder="知识库名称"]')`)
    )
    // 命名输入框 autoFocus，直接 insertText
    await send('Input.insertText', { text: KB_NAME })
    await waitFor('名称已入 state', () =>
      evaluate(`(() => {
        const i = document.querySelector('input[placeholder="知识库名称"]')
        return !!i && i.value === ${JSON.stringify(KB_NAME)}
      })()`)
    )
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '创建')
      btn?.click(); return true
    })()`)
    console.log('1. 创建知识库 → 命名模态 → 创建: ok')

    // 2) KB 图标出现（title 含名字），点击选中 → 详情面板出现
    //    取「最后一个」匹配图标 = 刚创建的（DOM 顺序即创建顺序），规避重名残留
    await waitFor('KB 图标出现', () =>
      evaluate(`!!document.querySelector('button[title*="${KB_NAME}"]')`)
    )
    await evaluate(`(() => {
      const list = [...document.querySelectorAll('button')].filter((b) => (b.title || '').includes(${JSON.stringify(KB_NAME)}))
      list[list.length - 1]?.click(); return true
    })()`)
    await waitFor('详情面板', () =>
      evaluate(`!!document.querySelector('button[title^="上传文件"]')`)
    )
    console.log('2. 选中 KB → 详情面板: ok')

    // 3) 上传文件：【真实可信鼠标事件】点上传菜单 → 断言菜单项确实对 file input 调了 .click()
    //    （Electron 无 Page.setInterceptFileChooser，无法直接观测原生对话框；
    //     真实手势内 input.click() 后对话框由 Chromium 保证弹出，此处验证到 click() 一层。
    //     录制器拦截 file input 的 click 以免自动化期间弹出原生对话框卡住流程。）
    await evaluate(`(() => {
      if (window.__fileClickPatched) return true
      window.__fileClicks = []
      const orig = HTMLInputElement.prototype.click
      HTMLInputElement.prototype.click = function () {
        if (this.type === 'file') {
          window.__fileClicks.push({
            directory: this.hasAttribute('webkitdirectory'),
            accept: this.getAttribute('accept') || ''
          })
          return // 自动化期间抑制原生对话框
        }
        return orig.call(this)
      }
      window.__fileClickPatched = true
      return true
    })()`)
    await realClick('button[title^="上传文件"]')
    await waitFor('上传菜单出现', () =>
      evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '本地上传')`)
    )
    await realClickByText('本地上传')
    await waitFor('菜单项已触发 file input.click()', () =>
      evaluate(`(window.__fileClicks || []).some((c) => !c.directory && c.accept.includes('.docx'))`)
    )
    console.log('3a. 真实点击【本地上传】→ 触发文件选择（file input.click）: ok')

    const { nodeId: localInputId } = await send('DOM.querySelector', {
      nodeId: rootNodeId,
      selector: 'input[type="file"]:not([webkitdirectory])'
    })
    if (!localInputId) throw new Error('未找到本地上传文件输入框')
    await send('DOM.setFileInputFiles', { nodeId: localInputId, files: [UPLOAD_PATH] })
    // 上传=写文件+reindex 一体：首次 embedding 模型加载可达 ~45s，放宽到 120s
    await waitFor('文件行出现', () =>
      evaluate(`(() => {
        const row = [...document.querySelectorAll('aside button')].find((b) => b.title === '光锥笔记.html')
        return !!row
      })()`, 120000)
    )
    console.log('3b. 上传 html（中文名 UTF-8）→ 文件行: ok')

    // 第二个文件：txt（新支持格式走同一链路）
    await send('DOM.setFileInputFiles', { nodeId: localInputId, files: [TXT_UPLOAD_PATH] })
    await waitFor('txt 文件行出现', () =>
      evaluate(`(() => {
        const row = [...document.querySelectorAll('aside button')].find((b) => b.title === '格式说明.txt')
        return !!row
      })()`, 120000)
    )
    console.log('3c. 上传 txt（新格式）→ 文件行: ok')

    // 3d) 前端白名单过滤：注入 .exe → 不上传、出现「已跳过」琥珀提示
    await send('DOM.setFileInputFiles', { nodeId: localInputId, files: [BAD_UPLOAD_PATH] })
    await waitFor('已跳过提示出现', () =>
      evaluate(`[...document.querySelectorAll('div')].some((d) => d.textContent.includes('已跳过') && d.textContent.includes('不支持'))`)
    )
    const noExeRow = await evaluate(
      `![...document.querySelectorAll('aside button')].some((b) => (b.title || '').includes('跳过测试.exe'))`
    )
    if (!noExeRow) throw new Error('.exe 不应出现在文件列表')
    console.log('3d. 格式白名单：.exe 被跳过 + 提示: ok')

    // 4) 搜索过滤：点 [搜索] → 输入文件名前缀 → 仍显示该文件
    await evaluate(`document.querySelector('button[title="搜索文件"]').click(); true`)
    await waitFor('搜索输入框', () =>
      evaluate(`!!document.querySelector('input[placeholder="搜索文件…"]')`)
    )
    const searchInput = await evaluate(`(() => {
      const i = document.querySelector('input[placeholder="搜索文件…"]')
      i.focus()
      return !!i
    })()`)
    await send('Input.insertText', { text: '光锥' })
    await waitFor('过滤后仍有文件行', () =>
      evaluate(`(() => {
        const row = [...document.querySelectorAll('aside button')].find((b) => b.title === '光锥笔记.html')
        return !!row
      })()`)
    )
    console.log('4. 搜索过滤栏: ok')
    // 关闭搜索框（Escape）
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })

    // 5) 切到 AI 对话 → 开「基于知识库」→ 选择该知识库
    await waitFor('NA nav', () => clickNav('NA'))
    await waitFor('对话输入框', () =>
      evaluate(`!!document.querySelector('textarea[placeholder^="向 NA 提问"]')`)
    )
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('基于知识库'))
      b?.click(); return true
    })()`)
    await waitFor('知识库选择下拉触发钮', () =>
      evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('选择知识库'))
        return !!b
      })()`)
    )
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('选择知识库'))
      b?.click(); return true
    })()`)
    // 等待下拉菜单里的选项按钮真正出现（菜单渲染后才存在；触发器加载中会被禁用，故轮询重开）
    await waitFor('知识库选项（菜单已开）', () =>
      evaluate(`(() => {
        const opt = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '${KB_NAME}')
        if (opt) return true
        const trig = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('选择知识库'))
        if (trig && !trig.disabled) trig.click()
        return false
      })()`)
    )
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '${KB_NAME}')
      b?.click(); return true
    })()`)
    // 触发器不再显示「选择知识库」→ 已选中（kbId 已设）
    await waitFor('已选中知识库', () =>
      evaluate(`(() => {
        const trig = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('选择知识库'))
        return !trig
      })()`)
    )
    console.log('5. 开「基于知识库」→ 选中知识库: ok')

    // 6) 提问（纯知识库问答）→ 断言 assistant 气泡 + 引用 chips
    const ta = await waitFor('聊天输入框', () =>
      evaluate(`(() => {
        const i = document.querySelector('textarea')
        if (!i) return false
        i.focus()
        return true
      })()`)
    )
    await send('Input.insertText', { text: QUERY })
    await waitFor('提问已入 state', () =>
      evaluate(`(() => {
        const i = document.querySelector('textarea')
        return !!i && i.value === ${JSON.stringify(QUERY)}
      })()`)
    )
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    // 单路调用：answer + citations 一起返回，放宽到 45s（含 LLM 生成）。
    // 注意：chat-thread 的回答容器是 div.whitespace-pre-wrap（不是 p）；chips 内层 span 文本形如 `[1] 文档`
    await waitFor('知识库回答+引用 chips', () =>
      evaluate(`(() => {
        const el = [...document.querySelectorAll('div')].find((x) => x.className.includes('whitespace-pre-wrap') && x.textContent.trim().length > 10)
        if (!el) return false
        return [...document.querySelectorAll('span')].some((s) => /^\\[\\d+\\]/.test(s.textContent))
      })()`, 45000)
    )
    const answerPreview = await evaluate(`(() => {
      const els = [...document.querySelectorAll('div')].filter((x) => x.className.includes('whitespace-pre-wrap') && x.textContent.trim().length > 10)
      return (els[els.length - 1]?.textContent ?? '').slice(0, 60)
    })()`)
    console.log(`6. 知识库问答 + 引用 chips: ok | 回答开头: ${answerPreview}`)

    // 7) 回归：关「基于知识库」→ 点「新建对话」清空 → 普通对话 SSE 流式仍正常
    // 关开关：轮询点击直到「更多」按钮恢复显示（容忍首次合成点击偶发丢失）
    await waitFor('更多按钮恢复显示（关掉开关）', () =>
      evaluate(`(() => {
        const more = [...document.querySelectorAll('button')].some((x) => x.textContent.includes('更多'))
        if (more) return true
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('基于知识库'))
        if (b) b.click()
        return false
      })()`)
    )
    await evaluate(`document.querySelector('button[title="新建对话"]').click(); true`)
    await waitFor('会话清空（回到空态输入框）', () =>
      evaluate(`(() => {
        const i = document.querySelector('textarea')
        return !!i && !document.querySelector('div.whitespace-pre-wrap')
      })()`)
    )
    await evaluate(`document.querySelector('textarea').focus(); true`)
    await send('Input.insertText', { text: '你好' })
    await waitFor('普通提问已入 state', () =>
      evaluate(`(() => {
        const i = document.querySelector('textarea')
        return !!i && i.value === '你好'
      })()`)
    )
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await waitFor('普通对话流式回答', () =>
      evaluate(`(() => {
        const el = [...document.querySelectorAll('div')].find((x) => x.className.includes('whitespace-pre-wrap') && x.textContent.trim().length > 5)
        return !!el
      })()`, 45000)
    )
    console.log('7. 回归：普通对话（未开开关）流式: ok')

    // 8) 回知识库页，右键删除 KB（同时验证右键删除 + 清理测试数据）
    await waitFor('知识库 nav', () => clickNav('知识库'))
    await waitFor('KB 图标', () =>
      evaluate(`!!document.querySelector('button[title*="${KB_NAME}"]')`)
    )
    await evaluate(`(() => {
      const el = document.querySelector('button[title*="${KB_NAME}"]')
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }))
      return true
    })()`)
    await waitFor('右键菜单', () =>
      evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '删除知识库')`)
    )
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '删除知识库')
      b?.click(); return true
    })()`)
    await waitFor('删除确认浮层', () =>
      evaluate(`[...document.querySelectorAll('div')].some((d) => d.textContent.includes('删除该知识库？'))`)
    )
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '删除')
      b?.click(); return true
    })()`)
    await waitFor('KB 图标消失（已删除）', () =>
      evaluate(`!document.querySelector('button[title*="${KB_NAME}"]')`, 20000).catch(() => false)
    )
    console.log('8. 右键删除知识库（清理）: ok')

    console.log('=== 新知识库 CDP 冒烟全部通过 ===')
    process.exit(0)
  } catch (err) {
    console.error('=== 冒烟失败 ===')
    console.error(err)
    process.exit(1)
  }
}

ws.onerror = (err) => {
  console.error('ws error', err)
  process.exit(1)
}
