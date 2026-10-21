// Generates the 1024x1024 source app icon (a stylized robot joint) as PNG
// without external dependencies. Run `npx tauri icon app-icon.png` afterwards.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const N = 1024;
const px = Buffer.alloc(N * N * 4);
const set = (x, y, r, g, b, a = 255) => {
  const i = (y * N + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
};
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const u = (x - N / 2) / (N / 2), v = (y - N / 2) / (N / 2);
    // Rounded square background.
    const k = 0.78, rr = 0.22;
    const qx = Math.max(Math.abs(u) - k + rr, 0), qy = Math.max(Math.abs(v) - k + rr, 0);
    const inside = Math.hypot(qx, qy) <= rr + 0.12;
    if (!inside) { set(x, y, 0, 0, 0, 0); continue; }
    const t = (v + 1) / 2;
    let r = 30 + 20 * t, g = 34 + 24 * t, b = 48 + 40 * t;
    // Link bars and joints.
    const seg = (ax, ay, bx, by, w) => {
      const dx = bx - ax, dy = by - ay;
      const h = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(u - ax - dx * h, v - ay - dy * h) < w;
    };
    if (seg(-0.5, 0.5, 0.0, -0.1, 0.11) || seg(0.0, -0.1, 0.45, -0.45, 0.09)) { r = 255; g = 140; b = 40; }
    for (const [cx, cy, cr] of [[-0.5, 0.5, 0.2], [0.0, -0.1, 0.16], [0.45, -0.45, 0.12]]) {
      const d = Math.hypot(u - cx, v - cy);
      if (d < cr) { r = 230; g = 236; b = 245; }
      if (d < cr * 0.45) { r = 60; g = 140; b = 255; }
    }
    set(x, y, r, g, b);
  }
}
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
writeFileSync(process.argv[2] ?? "app-icon.png", Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
]));
