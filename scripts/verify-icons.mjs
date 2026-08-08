import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const icoPath = 'src-tauri/icons/icon.ico';
const icnsPath = 'src-tauri/icons/icon.icns';
const tauriBuildScriptPath = 'src-tauri/build.rs';
const expectedIcoSizes = [16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 112, 128, 256];
const expectedIcnsSizes = [16, 32, 64, 128, 256, 512, 1024];
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const pngAssets = new Map([
	['src-tauri/icons/32x32.png', 32],
	['src-tauri/icons/64x64.png', 64],
	['src-tauri/icons/128x128.png', 128],
	['src-tauri/icons/128x128@2x.png', 256],
	['src-tauri/icons/icon.png', 512],
	['src-tauri/icons/Square30x30Logo.png', 30],
	['src-tauri/icons/Square44x44Logo.png', 44],
	['src-tauri/icons/Square71x71Logo.png', 71],
	['src-tauri/icons/Square89x89Logo.png', 89],
	['src-tauri/icons/Square107x107Logo.png', 107],
	['src-tauri/icons/Square142x142Logo.png', 142],
	['src-tauri/icons/Square150x150Logo.png', 150],
	['src-tauri/icons/Square284x284Logo.png', 284],
	['src-tauri/icons/Square310x310Logo.png', 310],
	['src-tauri/icons/StoreLogo.png', 50],
	['public/favicon.png', 512]
]);

// iconutil emits legacy ic04/ic05 chunks on some macOS versions, while the
// PowerShell generator emits their PNG-based icp4/icp5 equivalents.
const icnsTypeSizes = new Map([
	['ic04', 16],
	['icp4', 16],
	['ic05', 32],
	['icp5', 32],
	['ic11', 32],
	['icp6', 64],
	['ic12', 64],
	['ic07', 128],
	['ic08', 256],
	['ic13', 256],
	['ic09', 512],
	['ic14', 512],
	['ic10', 1024]
]);
const legacyIcnsTypes = new Set(['ic04', 'ic05']);

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

function readPngChunks(buffer, label) {
	assert(buffer.length >= 8 && buffer.subarray(0, 8).equals(pngSignature), `${label} is not a PNG image`);

	const chunks = [];
	let offset = pngSignature.length;
	let reachedEnd = false;
	while (offset < buffer.length) {
		assert(offset + 12 <= buffer.length, `${label} has a truncated PNG chunk header`);
		const length = buffer.readUInt32BE(offset);
		const end = offset + 12 + length;
		assert(end <= buffer.length, `${label} has a truncated PNG chunk`);
		const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
		chunks.push({ type, data: buffer.subarray(offset + 8, offset + 8 + length) });
		offset = end;
		if (type === 'IEND') {
			reachedEnd = true;
			break;
		}
	}

	assert(reachedEnd, `${label} is missing its PNG IEND chunk`);
	assert(offset === buffer.length, `${label} has trailing data after its PNG IEND chunk`);
	assert(chunks[0]?.type === 'IHDR', `${label} must start with a PNG IHDR chunk`);
	return chunks;
}

function decodeRgbaPng(buffer, label) {
	const chunks = readPngChunks(buffer, label);
	const ihdr = chunks[0].data;
	assert(ihdr.length === 13, `${label} must contain a valid PNG IHDR chunk`);
	const width = ihdr.readUInt32BE(0);
	const height = ihdr.readUInt32BE(4);
	assert(width > 0 && height > 0, `${label} must have non-zero dimensions`);
	assert(ihdr[8] === 8 && ihdr[9] === 6, `${label} must use 8-bit RGBA pixels`);
	assert(ihdr[10] === 0 && ihdr[11] === 0, `${label} uses unsupported PNG compression or filtering`);
	assert(ihdr[12] === 0, `${label} must not be interlaced`);

	const compressed = chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data);
	assert(compressed.length > 0, `${label} is missing PNG pixel data`);
	const bytesPerPixel = 4;
	const stride = width * bytesPerPixel;
	const encoded = inflateSync(Buffer.concat(compressed));
	assert(encoded.length === height * (stride + 1), `${label} pixel data has an unexpected length`);
	const pixels = Buffer.alloc(height * stride);

	for (let y = 0; y < height; y++) {
		const encodedRow = y * (stride + 1);
		const pixelRow = y * stride;
		const filter = encoded[encodedRow];
		for (let x = 0; x < stride; x++) {
			const raw = encoded[encodedRow + 1 + x];
			const left = x >= bytesPerPixel ? pixels[pixelRow + x - bytesPerPixel] : 0;
			const up = y > 0 ? pixels[pixelRow - stride + x] : 0;
			const upLeft = y > 0 && x >= bytesPerPixel ? pixels[pixelRow - stride + x - bytesPerPixel] : 0;
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
				const prediction = left + up - upLeft;
				const leftDistance = Math.abs(prediction - left);
				const upDistance = Math.abs(prediction - up);
				const diagonalDistance = Math.abs(prediction - upLeft);
				value =
					raw +
					(leftDistance <= upDistance && leftDistance <= diagonalDistance
						? left
						: upDistance <= diagonalDistance
							? up
							: upLeft);
			} else {
				throw new Error(`${label} uses unsupported PNG filter ${filter}`);
			}
			pixels[pixelRow + x] = value & 0xff;
		}
	}

	return { width, height, pixels };
}

function readIcoEntries(buffer) {
	assert(buffer.length >= 6, `${icoPath} is too small to contain an ICO header`);
	assert(buffer.readUInt16LE(0) === 0, `${icoPath} has an invalid ICO reserved field`);
	assert(buffer.readUInt16LE(2) === 1, `${icoPath} is not an ICO image`);

	const count = buffer.readUInt16LE(4);
	const directoryLength = 6 + count * 16;
	assert(buffer.length >= directoryLength, `${icoPath} has a truncated ICO directory`);

	return Array.from({ length: count }, (_, index) => {
		const offset = 6 + index * 16;
		const width = buffer[offset] || 256;
		const height = buffer[offset + 1] || 256;
		const dataLength = buffer.readUInt32LE(offset + 8);
		const dataOffset = buffer.readUInt32LE(offset + 12);
		assert(width === height, `${icoPath} entry ${index} must be square, got ${width}x${height}`);
		assert(buffer.readUInt16LE(offset + 4) === 1, `${icoPath} entry ${index} must use one color plane`);
		assert(buffer.readUInt16LE(offset + 6) === 32, `${icoPath} entry ${index} must use 32-bit pixels`);
		assert(
			dataOffset >= directoryLength && dataOffset + dataLength <= buffer.length,
			`${icoPath} entry ${index} points outside the file`
		);
		const data = buffer.subarray(dataOffset, dataOffset + dataLength);
		const png = decodeRgbaPng(data, `${icoPath} entry ${index}`);
		assert(
			png.width === width && png.height === height,
			`${icoPath} entry ${index} directory size must match its ${png.width}x${png.height} PNG payload`
		);
		return { size: width, data, png };
	});
}

function readIcnsEntries(buffer) {
	assert(buffer.length >= 8, `${icnsPath} is too small to contain an ICNS header`);
	assert(buffer.subarray(0, 4).toString('ascii') === 'icns', `${icnsPath} has an invalid ICNS signature`);
	assert(buffer.readUInt32BE(4) === buffer.length, `${icnsPath} header size does not match the file length`);

	const entries = [];
	const seenTypes = new Set();
	let offset = 8;
	while (offset < buffer.length) {
		assert(offset + 8 <= buffer.length, `${icnsPath} has a truncated chunk header`);
		const type = buffer.subarray(offset, offset + 4).toString('ascii');
		const length = buffer.readUInt32BE(offset + 4);
		assert(length >= 8 && offset + length <= buffer.length, `${icnsPath} has an invalid ${type} chunk length`);
		assert(!seenTypes.has(type), `${icnsPath} contains duplicate ${type} chunks`);
		seenTypes.add(type);

		const data = buffer.subarray(offset + 8, offset + length);
		assert(type !== 'ic15', `${icnsPath} must not use the non-standard ic15 image type`);
		const expectedSize = icnsTypeSizes.get(type);
		if (expectedSize !== undefined) {
			if (data.subarray(0, pngSignature.length).equals(pngSignature)) {
				const png = decodeRgbaPng(data, `${icnsPath} ${type}`);
				assert(
					png.width === expectedSize && png.height === expectedSize,
					`${icnsPath} ${type} must contain a ${expectedSize}x${expectedSize} image, got ${png.width}x${png.height}`
				);
				entries.push({ type, size: expectedSize, png });
			} else {
				assert(legacyIcnsTypes.has(type), `${icnsPath} ${type} must contain a PNG image`);
				assert(data.length > 0, `${icnsPath} ${type} must not be empty`);
				entries.push({ type, size: expectedSize });
			}
		}
		offset += length;
	}

	assert(offset === buffer.length, `${icnsPath} chunks do not fill the declared file length`);
	const representedSizes = new Set(entries.map(entry => entry.size));
	for (const size of expectedIcnsSizes) {
		assert(representedSizes.has(size), `${icnsPath} is missing its ${size}x${size} representation`);
	}
	return entries;
}

function measureIconArtwork(png) {
	let brightCorePixels = 0;
	let outerLightPixels = 0;
	let visiblePixels = 0;
	let semiTransparentPixels = 0;
	for (let y = 0; y < png.height; y++) {
		for (let x = 0; x < png.width; x++) {
			const offset = (y * png.width + x) * 4;
			const red = png.pixels[offset];
			const green = png.pixels[offset + 1];
			const blue = png.pixels[offset + 2];
			const alpha = png.pixels[offset + 3];
			if (alpha > 16) {
				visiblePixels++;
			}
			if (alpha > 16 && alpha < 239) {
				semiTransparentPixels++;
			}
			if (alpha >= 200 && red >= 220 && green >= 220 && blue >= 220) {
				brightCorePixels++;
			}
			const outsideLogo =
				x < png.width * 0.22 || x > png.width * 0.78 || y < png.height * 0.09 || y > png.height * 0.93;
			if (outsideLogo && alpha > 16 && Math.max(red, green, blue) > 32) {
				outerLightPixels++;
			}
		}
	}
	return { brightCorePixels, outerLightPixels, visiblePixels, semiTransparentPixels };
}

function assertArtworkContract(png, label, checkSmallEdges) {
	const metrics = measureIconArtwork(png);
	assert(metrics.visiblePixels >= png.width * png.height * 0.6, `${label} artwork is too small for its canvas`);
	assert(
		metrics.brightCorePixels >= Math.max(8, Math.floor(png.width * png.height * 0.03)),
		`${label} N mark lacks a crisp high-contrast core`
	);
	assert(metrics.outerLightPixels === 0, `${label} contains a light matte outside the N mark`);
	if (checkSmallEdges) {
		assert(metrics.semiTransparentPixels <= metrics.visiblePixels * 0.27, `${label} has too many blurred edge pixels`);
	}
	return metrics;
}

const [ico, icns, tauriBuildScript, pngEntries] = await Promise.all([
	readFile(icoPath),
	readFile(icnsPath),
	readFile(tauriBuildScriptPath, 'utf8'),
	Promise.all(
		[...pngAssets].map(async ([path, expectedSize]) => {
			const data = await readFile(path);
			return [path, expectedSize, data, decodeRgbaPng(data, path)];
		})
	)
]);

const buildLines = new Set(tauriBuildScript.split(/\r?\n/).map(line => line.trim()));
for (const iconPath of ['icons/icon.ico', 'icons/icon.png', 'icons/icon.icns']) {
	assert(
		buildLines.has(`println!("cargo:rerun-if-changed=${iconPath}");`),
		`${tauriBuildScriptPath} must actively rebuild Tauri when ${iconPath} changes`
	);
}

const icoEntries = readIcoEntries(ico);
const icoSizes = icoEntries.map(entry => entry.size);
const sortedIcoSizes = [...icoSizes].sort((left, right) => left - right);
assert(
	icoSizes[0] === 32,
	`${icoPath} must put its 32x32 default Windows window icon first for Tauri, got ${icoSizes[0]}x${icoSizes[0]}`
);
assert(
	JSON.stringify(sortedIcoSizes) === JSON.stringify(expectedIcoSizes),
	`${icoPath} must contain exactly ${expectedIcoSizes.join(', ')} pixel images, got ${icoSizes.join(', ')}`
);
for (const entry of icoEntries) {
	assertArtworkContract(entry.png, `${icoPath} ${entry.size}px`, entry.size <= 48);
}

const icnsEntries = readIcnsEntries(icns);
const standalonePngs = new Map();
for (const [path, expectedSize, data, png] of pngEntries) {
	assert(
		png.width === expectedSize && png.height === expectedSize,
		`${path} must be ${expectedSize}x${expectedSize}, got ${png.width}x${png.height}`
	);
	assertArtworkContract(png, path, expectedSize <= 48);
	standalonePngs.set(path, { data, png });
}

assert(
	standalonePngs.get('src-tauri/icons/icon.png').data.equals(standalonePngs.get('public/favicon.png').data),
	'public/favicon.png must be an exact copy of src-tauri/icons/icon.png'
);
for (const [size, path] of [
	[32, 'src-tauri/icons/32x32.png'],
	[64, 'src-tauri/icons/64x64.png'],
	[128, 'src-tauri/icons/128x128.png'],
	[256, 'src-tauri/icons/128x128@2x.png']
]) {
	const icoEntry = icoEntries.find(entry => entry.size === size);
	assert(icoEntry.data.equals(standalonePngs.get(path).data), `${icoPath} ${size}px payload must match ${path}`);
}

const runtimeMetrics = measureIconArtwork(icoEntries[0].png);
const icnsTypes = icnsEntries.map(entry => entry.type).join('/');
console.log(
	`Icon verification passed: ${icoPath} preserves ${expectedIcoSizes.join('/')}px executable-resource images; ` +
		`Tauri's default Windows window entry is ${icoSizes[0]}px (${runtimeMetrics.brightCorePixels} crisp pixels). ` +
		`${icnsPath} covers ${expectedIcnsSizes.join('/')}px via ${icnsTypes}; ${pngAssets.size} standalone PNGs match their release contract.`
);
