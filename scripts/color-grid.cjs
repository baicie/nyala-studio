// Sample a PNG's pixel values across the image grid
const fs = require('fs');
const zlib = require('zlib');

const buf = fs.readFileSync(process.argv[2]);
let off = 8;
const chunks = [];
while (off < buf.length) {
  const size = buf.readUInt32BE(off);
  const type = buf.slice(off + 4, off + 8).toString('ascii');
  const data = buf.slice(off + 8, off + 8 + size);
  chunks.push({ type, size, data });
  off += 12 + size;
  if (type === 'IEND') break;
}
const ihdr = chunks.find(c => c.type === 'IHDR').data;
const w = ihdr.readUInt32BE(0);
const h = ihdr.readUInt32BE(4);
const colorType = ihdr[9];
const bpp = colorType === 6 ? 4 : 3;

const idatChunks = chunks.filter(c => c.type === 'IDAT');
const compressed = Buffer.concat(idatChunks.map(c => c.data));
const raw = zlib.inflateSync(compressed);
const stride = 1 + w * bpp;

const colorize = (r, g, b, a) => {
  if (a < 50) return '.';
  const lum = (r + g + b) / 3;
  if (lum > 240) return 'W';
  if (lum < 30) return '#';
  if (r > g + 30 && r > b + 30 && r > 100) return 'R';  // red/orange
  if (g > r + 30 && g > b + 30 && g > 100) return 'G';
  if (b > r + 30 && b > g + 30) return 'B';
  if (r > 150 && g > 100 && b < 100) return 'Y';  // yellow
  if (r > 100 && g > 80 && b < 100) return 'O';  // orange/light brown
  if (r > 50 && g > 30 && b > 20 && r > g && g > b) return 'o';  // brown
  return '-';
};

const cell = parseInt(process.argv[3] || '32');
for (let cy = 0; cy < h; cy += cell) {
  let line = '';
  for (let cx = 0; cx < w; cx += cell) {
    let ar = 0, ag = 0, ab = 0, aa = 0, n = 0;
    for (let y = cy; y < Math.min(cy + cell, h); y++) {
      for (let x = cx; x < Math.min(cx + cell, w); x++) {
        const o = y * stride + 1 + x * bpp;
        ar += raw[o]; ag += raw[o+1]; ab += raw[o+2]; aa += raw[o+3];
        n++;
      }
    }
    ar = ar / n; ag = ag / n; ab = ab / n; aa = aa / n;
    line += colorize(ar, ag, ab, aa);
  }
  console.log(line);
}