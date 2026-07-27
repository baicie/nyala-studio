import { readFile } from 'node:fs/promises';

const icoPath = 'src-tauri/icons/icon.ico';
const expectedSizes = [16, 24, 32, 48, 64, 128, 256];
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
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
		assert(
			dataOffset >= directoryLength && dataOffset + dataLength <= buffer.length,
			`${icoPath} entry ${index} points outside the file`
		);
		assert(
			buffer.subarray(dataOffset, dataOffset + pngSignature.length).equals(pngSignature),
			`${icoPath} entry ${index} must contain a PNG image`
		);
		assert(dataLength >= 24, `${icoPath} entry ${index} has a truncated PNG header`);
		assert(
			buffer.subarray(dataOffset + 12, dataOffset + 16).toString('ascii') === 'IHDR',
			`${icoPath} entry ${index} must start with a PNG IHDR chunk`
		);
		assert(
			buffer.readUInt32BE(dataOffset + 16) === width && buffer.readUInt32BE(dataOffset + 20) === height,
			`${icoPath} entry ${index} directory size must match its PNG payload`
		);
		return width;
	});
}

const ico = await readFile(icoPath);
const sizes = readIcoEntries(ico);
const sortedSizes = [...sizes].sort((left, right) => left - right);

assert(sizes[0] === 256, `${icoPath} must put its 256x256 image first for Tauri on Windows`);
assert(
	JSON.stringify(sortedSizes) === JSON.stringify(expectedSizes),
	`${icoPath} must contain exactly ${expectedSizes.join(', ')} pixel images, got ${sizes.join(', ')}`
);

console.log(`Icon verification passed: ${icoPath} starts at ${sizes[0]}x${sizes[0]}.`);
