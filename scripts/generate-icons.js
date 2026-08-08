// Run once: node scripts/generate-icons.js
// Generates PWA icons in public/ using only Node built-ins
import { deflateSync } from 'zlib'
import { writeFileSync, mkdirSync } from 'fs'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xFFFFFFFF
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crcBuf = Buffer.concat([t, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(crcBuf))
  return Buffer.concat([len, t, data, crc])
}

function makePNG(size) {
  const pixels = new Uint8Array(size * size * 4)
  const teal    = [13, 122, 107, 255]
  const white   = [255, 255, 255, 255]
  const bg      = [246, 245, 241, 255]
  const corner  = Math.round(size * 0.20)

  // Rounded rectangle background
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(corner - x, 0, x - (size - 1 - corner))
      const dy = Math.max(corner - y, 0, y - (size - 1 - corner))
      const inside = dx * dx + dy * dy <= corner * corner
      const i = (y * size + x) * 4
      const c = inside ? teal : bg
      pixels[i] = c[0]; pixels[i+1] = c[1]; pixels[i+2] = c[2]; pixels[i+3] = c[3]
    }
  }

  // Draw "S" as pixel blocks scaled to icon size
  const s = size / 192
  function fill(x1, y1, x2, y2, color) {
    for (let y = Math.round(y1*s); y < Math.round(y2*s); y++) {
      for (let x = Math.round(x1*s); x < Math.round(x2*s); x++) {
        if (x < 0 || x >= size || y < 0 || y >= size) continue
        const i = (y * size + x) * 4
        pixels[i] = color[0]; pixels[i+1] = color[1]; pixels[i+2] = color[2]; pixels[i+3] = color[3]
      }
    }
  }

  // "S" shape on a 192×192 grid
  const lx = 56, rx = 136, ty = 38, by = 154, my = 96, sw = 20
  fill(lx+14, ty,      rx,    ty+sw, white) // top bar
  fill(lx,    ty,      lx+sw, my,    white) // top-left stem
  fill(lx,    my-sw/2, rx,    my+sw/2, white) // middle bar
  fill(rx-sw, my,      rx,    by,    white) // bottom-right stem
  fill(lx,    by-sw,   rx-14, by,    white) // bottom bar

  // Build PNG (RGBA)
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6 // bit depth 8, color type RGBA

  const rows = []
  for (let y = 0; y < size; y++) {
    rows.push(0)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      rows.push(pixels[i], pixels[i+1], pixels[i+2], pixels[i+3])
    }
  }

  const compressed = deflateSync(Buffer.from(rows), { level: 6 })

  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))])
}

mkdirSync('public', { recursive: true })
for (const size of [192, 512]) {
  writeFileSync(`public/icon-${size}.png`, makePNG(size))
  console.log(`✓ public/icon-${size}.png`)
}
writeFileSync('public/apple-touch-icon.png', makePNG(180))
console.log('✓ public/apple-touch-icon.png')
console.log('Done — icons generated in public/')
