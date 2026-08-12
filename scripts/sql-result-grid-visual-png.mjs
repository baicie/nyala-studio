import { inflateSync } from 'node:zlib';

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function inspectPngPixels(bytes) {
	if (bytes.byteLength < pngSignature.length || !bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
		throw new Error('file does not have a PNG signature');
	}
	let offset = pngSignature.length;
	let header;
	const compressed = [];
	while (offset + 12 <= bytes.byteLength) {
		const length = bytes.readUInt32BE(offset);
		const type = bytes.toString('ascii', offset + 4, offset + 8);
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;
		if (dataEnd + 4 > bytes.byteLength) throw new Error(`PNG ${type} chunk exceeds file bounds`);
		const data = bytes.subarray(dataStart, dataEnd);
		if (type === 'IHDR') header = readHeader(data);
		if (type === 'IDAT') compressed.push(data);
		offset = dataEnd + 4;
		if (type === 'IEND') break;
	}
	if (!header) throw new Error('PNG is missing IHDR');
	if (compressed.length === 0) throw new Error('PNG is missing IDAT');
	if (header.bitDepth !== 8 || header.interlace !== 0) {
		throw new Error(`unsupported PNG bit depth/interlace: ${header.bitDepth}/${header.interlace}`);
	}
	const bytesPerPixel = bytesPerPixelFor(header.colorType);
	const rowBytes = header.width * bytesPerPixel;
	const inflated = inflateSync(Buffer.concat(compressed));
	const expectedBytes = header.height * (rowBytes + 1);
	if (inflated.byteLength !== expectedBytes) {
		throw new Error(`PNG pixel payload is ${inflated.byteLength} bytes; expected ${expectedBytes}`);
	}
	const pixels = unfilter(inflated, header.height, rowBytes, bytesPerPixel);
	const sampleStep = Math.max(1, Math.floor((header.width * header.height) / 100_000));
	const colorBuckets = new Set();
	let sampledPixels = 0;
	let visiblePixels = 0;
	let minimumLuma = 255;
	let maximumLuma = 0;
	for (let pixel = 0; pixel < header.width * header.height; pixel += sampleStep) {
		const [red, green, blue, alpha] = readPixel(pixels, pixel * bytesPerPixel, header.colorType);
		sampledPixels += 1;
		if (alpha <= 16) continue;
		visiblePixels += 1;
		colorBuckets.add(`${red >> 4}:${green >> 4}:${blue >> 4}`);
		const luma = Math.round((red * 299 + green * 587 + blue * 114) / 1_000);
		minimumLuma = Math.min(minimumLuma, luma);
		maximumLuma = Math.max(maximumLuma, luma);
	}
	return {
		...header,
		sampledPixels,
		visiblePixels,
		visiblePixelRatio: sampledPixels === 0 ? 0 : visiblePixels / sampledPixels,
		distinctColorBuckets: colorBuckets.size,
		lumaRange: visiblePixels === 0 ? 0 : maximumLuma - minimumLuma
	};
}

export function hasVisiblePngDiversity(analysis) {
	return analysis.visiblePixelRatio >= 0.95 && analysis.distinctColorBuckets >= 4 && analysis.lumaRange >= 24;
}

function readHeader(data) {
	if (data.byteLength !== 13) throw new Error('PNG IHDR must be 13 bytes');
	const width = data.readUInt32BE(0);
	const height = data.readUInt32BE(4);
	if (width < 1 || height < 1) throw new Error('PNG dimensions must be positive');
	return {
		width,
		height,
		bitDepth: data[8],
		colorType: data[9],
		compression: data[10],
		filter: data[11],
		interlace: data[12]
	};
}

function bytesPerPixelFor(colorType) {
	switch (colorType) {
		case 0:
			return 1;
		case 2:
			return 3;
		case 4:
			return 2;
		case 6:
			return 4;
		default:
			throw new Error(`unsupported PNG color type: ${colorType}`);
	}
}

function unfilter(source, height, rowBytes, bytesPerPixel) {
	const target = Buffer.alloc(height * rowBytes);
	for (let row = 0; row < height; row += 1) {
		const sourceOffset = row * (rowBytes + 1);
		const targetOffset = row * rowBytes;
		const filter = source[sourceOffset];
		for (let column = 0; column < rowBytes; column += 1) {
			const raw = source[sourceOffset + column + 1];
			const left = column >= bytesPerPixel ? target[targetOffset + column - bytesPerPixel] : 0;
			const up = row > 0 ? target[targetOffset - rowBytes + column] : 0;
			const upLeft = row > 0 && column >= bytesPerPixel ? target[targetOffset - rowBytes + column - bytesPerPixel] : 0;
			target[targetOffset + column] = (raw + filterPredictor(filter, left, up, upLeft)) & 0xff;
		}
	}
	return target;
}

function filterPredictor(filter, left, up, upLeft) {
	switch (filter) {
		case 0:
			return 0;
		case 1:
			return left;
		case 2:
			return up;
		case 3:
			return Math.floor((left + up) / 2);
		case 4:
			return paeth(left, up, upLeft);
		default:
			throw new Error(`unsupported PNG row filter: ${filter}`);
	}
}

function paeth(left, up, upLeft) {
	const prediction = left + up - upLeft;
	const leftDistance = Math.abs(prediction - left);
	const upDistance = Math.abs(prediction - up);
	const diagonalDistance = Math.abs(prediction - upLeft);
	if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left;
	return upDistance <= diagonalDistance ? up : upLeft;
}

function readPixel(pixels, offset, colorType) {
	switch (colorType) {
		case 0:
			return [pixels[offset], pixels[offset], pixels[offset], 255];
		case 2:
			return [pixels[offset], pixels[offset + 1], pixels[offset + 2], 255];
		case 4:
			return [pixels[offset], pixels[offset], pixels[offset], pixels[offset + 1]];
		case 6:
			return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
		default:
			throw new Error(`unsupported PNG color type: ${colorType}`);
	}
}
