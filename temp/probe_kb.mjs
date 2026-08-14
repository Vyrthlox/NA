const wsUrl = process.argv[2]
const ws = new WebSocket(wsUrl)
let seq = 0
const pending = new Map()
function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res, rej) => pending.set(id, { res, rej }))
}
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(m.error.message)) : res(m.result)
  }
}
ws.onopen = async () => {
  try {
    await send('Runtime.enable')
    const evalIt = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.value
    console.log('KB icons:', await evalIt(`JSON.stringify([...document.querySelectorAll('button')].filter(b => (b.title||'').includes('文件 ·')).map(b => b.title))`))
    console.log('aside present:', await evalIt(`!!document.querySelector('aside')`))
    console.log('upload btn (prefix):', await evalIt(`JSON.stringify([...document.querySelectorAll('button')].map(b => b.title).filter(t => t && t.startsWith('上传')))`))
    // click the smoke KB icon and re-check after a beat
    await evalIt(`(() => { const b = [...document.querySelectorAll('button')].find(b => (b.title||'').includes('冒烟测试库')); if (b) { b.click(); return 'clicked' } return 'not-found' })()`)
    await new Promise(r => setTimeout(r, 1500))
    console.log('after click, aside:', await evalIt(`!!document.querySelector('aside')`))
    console.log('after click, all titles:', await evalIt(`JSON.stringify([...document.querySelectorAll('aside button')].map(b => b.title || b.textContent.trim().slice(0,12)))`))
    process.exit(0)
  } catch (e) { console.error(e); process.exit(1) }
}
