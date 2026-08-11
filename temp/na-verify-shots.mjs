// 像素级验证：确认截图里立方体在动画（相邻帧有局部差异）+ 差异区域尺寸符合立方体
import fs from 'node:fs'
import path from 'node:path'

const wsUrl = process.argv[2]
const shotsDir = process.argv[3] ?? '.'

const names = ['thinking-1.png', 'thinking-2.png', 'thinking-3.png']
const b64s = names.map((n) => fs.readFileSync(path.join(shotsDir, n)).toString('base64'))

const ws = new WebSocket(wsUrl)
let id = 0
const pending = new Map()
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
  }
}
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
await send('Runtime.enable')

const expr = `
(async () => {
  const b64s = ${JSON.stringify(b64s)};
  const canvases = [];
  for (const b of b64s) {
    const bin = atob(b);
    const bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    const blob = new Blob([bytes], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    canvases.push({ img, g, w: c.width, h: c.height });
    URL.revokeObjectURL(url);
  }
  const diffPixels = (a, b) => {
    const ia = a.g.getImageData(0, 0, a.w, a.h).data;
    const ib = b.g.getImageData(0, 0, b.w, b.h).data;
    let count = 0, minX = a.w, minY = a.h, maxX = 0, maxY = 0;
    for (let y = 0; y < a.h; y++) {
      for (let x = 0; x < a.w; x++) {
        const i = (y * a.w + x) * 4;
        const d = Math.abs(ia[i] - ib[i]) + Math.abs(ia[i+1] - ib[i+1]) + Math.abs(ia[i+2] - ib[i+2]);
        if (d > 40) {
          count++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    return { count, bbox: count ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null };
  };
  const d12 = diffPixels(canvases[0], canvases[1]);
  const d23 = diffPixels(canvases[1], canvases[2]);
  const d13 = diffPixels(canvases[0], canvases[2]);
  return { size: canvases[0].w + 'x' + canvases[0].h, d12, d23, d13 };
})()
`

const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
console.log('FULL_RESULT', JSON.stringify(res, null, 2))
if (res.result?.exceptionDetails) console.log('EXC', JSON.stringify(res.result.exceptionDetails, null, 2))
ws.close()
process.exit(0)
