#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const sourcePath = resolve(process.argv[2] ?? 'src-tauri/icons/icon-source.png');
const outputDir = resolve(process.argv[3] ?? 'src-tauri/icons');
const tmpRoot = mkdtempSync(join(tmpdir(), 'nyala-icons-'));
const workDir = join(tmpRoot, 'work');
const iconsetDir = join(tmpRoot, 'icon.iconset');
const coverage = 0.86;

const pngSizes = new Map([
	['32x32.png', 32],
	['64x64.png', 64],
	['128x128.png', 128],
	['128x128@2x.png', 256],
	['icon.png', 512],
	['Square30x30Logo.png', 30],
	['Square44x44Logo.png', 44],
	['Square71x71Logo.png', 71],
	['Square89x89Logo.png', 89],
	['Square107x107Logo.png', 107],
	['Square142x142Logo.png', 142],
	['Square150x150Logo.png', 150],
	['Square284x284Logo.png', 284],
	['Square310x310Logo.png', 310],
	['StoreLogo.png', 50],
]);

const iconsetSizes = [
	['icon_16x16.png', 16],
	['icon_16x16@2x.png', 32],
	['icon_32x32.png', 32],
	['icon_32x32@2x.png', 64],
	['icon_128x128.png', 128],
	['icon_128x128@2x.png', 256],
	['icon_256x256.png', 256],
	['icon_256x256@2x.png', 512],
	['icon_512x512.png', 512],
	['icon_512x512@2x.png', 1024],
];

// Tauri's Windows icon loader uses the first ICO entry. Keep the largest
// image first so Windows never scales the 16px rendition for app surfaces.
const icoSizes = [256, 128, 64, 48, 32, 24, 16];

function run(command, args) {
	execFileSync(command, args, { stdio: 'pipe' });
}

function writeIco(entries, destination) {
	const images = entries.map(({ size, path }) => ({ size, data: readFileSync(path) }));
	const headerSize = 6 + images.length * 16;
	const header = Buffer.alloc(headerSize);
	let offset = headerSize;
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);
	for (const [index, image] of images.entries()) {
		const entryOffset = 6 + index * 16;
		header[entryOffset] = image.size >= 256 ? 0 : image.size;
		header[entryOffset + 1] = image.size >= 256 ? 0 : image.size;
		header.writeUInt16LE(1, entryOffset + 4);
		header.writeUInt16LE(32, entryOffset + 6);
		header.writeUInt32LE(image.data.length, entryOffset + 8);
		header.writeUInt32LE(offset, entryOffset + 12);
		offset += image.data.length;
	}
	writeFileSync(destination, Buffer.concat([header, ...images.map(image => image.data)]));
}

function crc32(buffer) {
	let crc = ~0;
	for (const byte of buffer) {
		crc ^= byte;
		for (let k = 0; k < 8; k++) {
			crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
		}
	}
	return ~crc >>> 0;
}

function pngChunk(type, data) {
	const typeBuffer = Buffer.from(type, 'ascii');
	const chunk = Buffer.alloc(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	typeBuffer.copy(chunk, 4);
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
	return chunk;
}

function cleanWhiteEdges(pngPath) {
	const file = readFileSync(pngPath);
	const chunks = [];
	for (let offset = 8; offset < file.length;) {
		const length = file.readUInt32BE(offset);
		const type = file.slice(offset + 4, offset + 8).toString('ascii');
		const data = file.slice(offset + 8, offset + 8 + length);
		chunks.push({ type, data });
		offset += 12 + length;
		if (type === 'IEND') {
			break;
		}
	}

	const ihdr = chunks.find(chunk => chunk.type === 'IHDR')?.data;
	if (!ihdr || ihdr[8] !== 8 || ihdr[9] !== 6) {
		return;
	}
	const width = ihdr.readUInt32BE(0);
	const height = ihdr.readUInt32BE(4);
	const bpp = 4;
	const stride = width * bpp;
	const inflated = inflateSync(Buffer.concat(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data)));
	const pixels = Buffer.alloc(height * stride);

	for (let y = 0; y < height; y++) {
		const sourceRow = y * (stride + 1);
		const targetRow = y * stride;
		const filter = inflated[sourceRow];
		for (let x = 0; x < stride; x++) {
			const raw = inflated[sourceRow + 1 + x];
			const left = x >= bpp ? pixels[targetRow + x - bpp] : 0;
			const up = y > 0 ? pixels[targetRow - stride + x] : 0;
			const upLeft = y > 0 && x >= bpp ? pixels[targetRow - stride + x - bpp] : 0;
			let value;
			if (filter === 0) {
				value = raw;
			} else if (filter === 1) {
				value = raw + left;
			} else if (filter === 2) {
				value = raw + up;
			} else if (filter === 3) {
				value = raw + Math.floor((left + up) / 2);
			} else if (filter === 4) {
				const p = left + up - upLeft;
				const pa = Math.abs(p - left);
				const pb = Math.abs(p - up);
				const pc = Math.abs(p - upLeft);
				value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
			} else {
				throw new Error(`Unsupported PNG filter ${filter}`);
			}
			pixels[targetRow + x] = value & 0xff;
		}
	}

	const logoMinX = Math.floor(width * (0.07 + coverage * 0.23));
	const logoMaxX = Math.ceil(width * (0.07 + coverage * 0.77));
	const logoMinY = Math.floor(height * (0.07 + coverage * 0.14));
	const logoMaxY = Math.ceil(height * (0.07 + coverage * 0.88));
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const offset = y * stride + x * bpp;
			const r = pixels[offset];
			const g = pixels[offset + 1];
			const b = pixels[offset + 2];
			const a = pixels[offset + 3];
			const insideLogo = x >= logoMinX && x <= logoMaxX && y >= logoMinY && y <= logoMaxY;
			const whiteOutsideLogo = !insideLogo && a > 0 && r > 140 && g > 140 && b > 140;
			if (whiteOutsideLogo) {
				pixels[offset] = 0;
				pixels[offset + 1] = 0;
				pixels[offset + 2] = 0;
				pixels[offset + 3] = 0;
			}
		}
	}

	const raw = Buffer.alloc(height * (stride + 1));
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}
	const png = Buffer.concat([
		file.slice(0, 8),
		pngChunk('IHDR', ihdr),
		pngChunk('IDAT', deflateSync(raw)),
		pngChunk('IEND', Buffer.alloc(0)),
	]);
	writeFileSync(pngPath, png);
}

try {
	statSync(sourcePath);
	mkdirSync(workDir, { recursive: true });
	mkdirSync(iconsetDir, { recursive: true });
	mkdirSync(outputDir, { recursive: true });

	const rendererPath = join(tmpRoot, 'render-icon.swift');
	const rendererBin = join(tmpRoot, 'render-icon');
	writeFileSync(
		rendererPath,
		`
import AppKit
import Foundation

let sourcePath = CommandLine.arguments[1]
let destinationPath = CommandLine.arguments[2]
let canvasSize = Int(CommandLine.arguments[3])!
let coverage = CGFloat(Double(CommandLine.arguments[4])!)

guard let sourceImage = NSImage(contentsOfFile: sourcePath),
	let sourceData = sourceImage.tiffRepresentation,
	let source = NSBitmapImageRep(data: sourceData) else {
	fatalError("Unable to read source image")
}

let sourceWidth = source.pixelsWide
let sourceHeight = source.pixelsHigh
var minX = sourceWidth
var minY = sourceHeight
var maxX = 0
var maxY = 0

for y in 0..<sourceHeight {
	for x in 0..<sourceWidth {
		var pixel = [Int](repeating: 0, count: 4)
		source.getPixel(&pixel, atX: x, y: y)
		if pixel[3] > 8 {
			minX = min(minX, x)
			minY = min(minY, y)
			maxX = max(maxX, x)
			maxY = max(maxY, y)
		}
	}
}

let crop = NSRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
let size = CGFloat(canvasSize)
let innerSize = size * coverage
let innerRect = NSRect(x: (size - innerSize) / 2, y: (size - innerSize) / 2, width: innerSize, height: innerSize)

let bitmap = NSBitmapImageRep(
	bitmapDataPlanes: nil,
	pixelsWide: canvasSize,
	pixelsHigh: canvasSize,
	bitsPerSample: 8,
	samplesPerPixel: 4,
	hasAlpha: true,
	isPlanar: false,
	colorSpaceName: .deviceRGB,
	bytesPerRow: 0,
	bitsPerPixel: 0
)!

let image = NSImage(size: NSSize(width: sourceWidth, height: sourceHeight))
image.addRepresentation(source)

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor.clear.setFill()
NSRect(x: 0, y: 0, width: size, height: size).fill()
image.draw(in: innerRect, from: crop, operation: .copy, fraction: 1.0)
NSGraphicsContext.restoreGraphicsState()

func isWhiteBackground(_ pixel: [Int]) -> Bool {
	let alpha = pixel[3]
	return alpha > 0 && pixel[0] > 150 && pixel[1] > 150 && pixel[2] > 150
}

func clearPixel(_ x: Int, _ y: Int) {
	var transparent = [0, 0, 0, 0]
	bitmap.setPixel(&transparent, atX: x, y: y)
}

let logoMinX = Int((innerRect.minX + innerSize * 0.23).rounded(.down))
let logoMaxX = Int((innerRect.minX + innerSize * 0.77).rounded(.up))
let logoMinY = Int((innerRect.minY + innerSize * 0.14).rounded(.down))
let logoMaxY = Int((innerRect.minY + innerSize * 0.88).rounded(.up))

for y in 0..<canvasSize {
	for x in 0..<canvasSize {
		let insideLogo = x >= logoMinX && x <= logoMaxX && y >= logoMinY && y <= logoMaxY
		if insideLogo {
			continue
		}
		var pixel = [Int](repeating: 0, count: 4)
		bitmap.getPixel(&pixel, atX: x, y: y)
		if isWhiteBackground(pixel) {
			clearPixel(x, y)
		}
	}
}

guard let data = bitmap.representation(using: .png, properties: [:]) else {
	fatalError("Unable to encode PNG")
}
try data.write(to: URL(fileURLWithPath: destinationPath), options: .atomic)
`,
		'utf8',
	);

	run('swiftc', [rendererPath, '-o', rendererBin]);
	const render = (destination, size) => run(rendererBin, [sourcePath, destination, String(size), String(coverage)]);

	for (const [name, size] of pngSizes) {
		const path = join(outputDir, name);
		render(path, size);
		cleanWhiteEdges(path);
	}
	for (const [name, size] of iconsetSizes) {
		const path = join(iconsetDir, name);
		render(path, size);
		cleanWhiteEdges(path);
	}
	run('iconutil', ['-c', 'icns', iconsetDir, '-o', join(outputDir, 'icon.icns')]);

	const icoEntries = icoSizes.map(size => {
		const path = join(workDir, `ico-${size}.png`);
		render(path, size);
		cleanWhiteEdges(path);
		return { size, path };
	});
	writeIco(icoEntries, join(outputDir, 'icon.ico'));
	copyFileSync(join(outputDir, 'icon.png'), resolve('public/favicon.png'));
	console.log(`Generated icons from ${basename(sourcePath)} with ${Math.round(coverage * 100)}% coverage`);
} finally {
	rmSync(tmpRoot, { recursive: true, force: true });
}
