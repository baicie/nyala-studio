const fs = require('fs');
const path = require('path');

const icnsPath = process.argv[2];
const outDir = process.argv[3] || '.';
fs.mkdirSync(outDir, { recursive: true });

const buf = fs.readFileSync(icnsPath);
console.log('icns magic:', buf.slice(0, 4).toString('ascii'), 'size:', buf.length);

const knownSizes = {
  icp4: [16, 16], icp5: [32, 32], icp6: [64, 64],
  ic07: [128, 128], ic08: [256, 256], ic09: [512, 512],
  ic10: [16, 16, '2x'], ic11: [32, 32, '2x'], ic12: [64, 64, '2x'],
  ic13: [128, 128, '2x'], ic14: [256, 256, '2x'], ic15: [512, 512, '2x'],
  ic16: [256, 256], ic17: [512, 512], ic18: [1024, 1024],
  is32: null, s8mk: null, il32: null, l8mk: null, is16: null,
};

let off = 8;
while (off < buf.length) {
  const type = buf.slice(off, off + 4).toString('ascii');
  const size = buf.readUInt32BE(off + 4);
  if (type === 'TOC ' || type === 'icnV' || type === 'name' || type === 'info') {
    console.log(`  skip metadata: ${type} size=${size}`);
    off += size;
    continue;
  }
  if (!(type in knownSizes)) {
    console.log(`  unknown chunk: ${type} size=${size} (skip)`);
    off += size;
    continue;
  }
  if (knownSizes[type] === null) {
    console.log(`  mask chunk: ${type} size=${size} (skip)`);
    off += size;
    continue;
  }
  const data = buf.slice(off + 8, off + size);
  const meta = knownSizes[type];
  const fname = path.join(outDir, `${type}-${meta[0]}x${meta[1]}${meta[2] ? '@' + meta[2] : ''}.png`);
  fs.writeFileSync(fname, data);
  console.log(`  ${type}: ${size} bytes -> ${path.basename(fname)}`);
  off += size;
}