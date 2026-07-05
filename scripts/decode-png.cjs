// Decode a PNG file's first scanline(s) raw using node's zlib
const fs = require('fs');
const zlib = require('zlib');

const buf = fs.readFileSync(process.argv[2]);
const sig = buf.slice(0, 8).toString('hex');
console.log('PNG sig:', sig);

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
const bitDepth = ihdr[8];
const colorType = ihdr[9];
console.log(`IHDR: ${w}x${h} bit=${bitDepth} color=${colorType}`);
// colorType 6 = RGBA, 4 bytes/pixel
const bytesPerPixel = colorType === 6 ? 4 : 3;

const idatChunks = chunks.filter(c => c.type === 'IDAT');
const compressed = Buffer.concat(idatChunks.map(c => c.data));
const raw = zlib.inflateSync(compressed);
console.log('inflated size:', raw.length, 'expected:', h * (1 + w * bytesPerPixel));

// Scanline 0 starts at offset 0
const sl0 = [];
for (let x = 0; x < w; x++) {
  const o = 1 + x * bytesPerPixel;
  sl0.push([raw[o], raw[o+1], raw[o+2], raw[o+3]]);
}
// Sample every 32 px on row 0
console.log('row 0 samples:');
for (let x = 0; x < w; x += 32) {
  const [r, g, b, a] = sl0[x];
  console.log(`  x=${x}: R=${r} G=${g} B=${b} A=${a}`);
}

// Find center column scanline (y=h/2)
const slY = Math.floor(h / 2);
const sl = [];
const off0 = slY * (1 + w * bytesPerPixel);
for (let x = 0; x < w; x++) {
  const o = off0 + 1 + x * bytesPerPixel;
  sl.push([raw[o], raw[o+1], raw[o+2], raw[o+3]]);
}
console.log(`row ${slY} samples:`);
for (let x = 0; x < w; x += 32) {
  const [r, g, b, a] = sl[x];
  console.log(`  x=${x}: R=${r} G=${g} B=${b} A=${a}`);
}