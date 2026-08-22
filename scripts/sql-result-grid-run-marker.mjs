import { decodePngPixels, readDecodedPngPixel } from './sql-result-grid-visual-png.mjs';

export const SQL_RESULT_GRID_RUN_MARKER_VERSION = 1;
export const SQL_RESULT_GRID_RUN_MARKER_MAGIC = Object.freeze([0x4e, 0x31]);
export const SQL_RESULT_GRID_RUN_MARKER_LAYOUT = Object.freeze({
	left: 4,
	bottom: 1,
	cellSize: 3,
	columns: 40,
	rows: 4,
	frame: 1,
	totalColumns: 42,
	totalRows: 6
});

const runTokenPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const minimumFrameContrast = 96;

export function createSqlResultGridRunMarkerBytes(runToken) {
	if (!runTokenPattern.test(runToken)) throw new Error(`run token is invalid: ${String(runToken)}`);
	const tokenBytes = runToken
		.replaceAll('-', '')
		.match(/../g)
		.map(value => Number.parseInt(value, 16));
	const payload = Uint8Array.from([...SQL_RESULT_GRID_RUN_MARKER_MAGIC, ...tokenBytes]);
	const checksum = crc16Ccitt(payload);
	return Uint8Array.from([...payload, checksum >> 8, checksum & 0xff]);
}

export function inspectSqlResultGridRunMarker(pngBytes, expectedRunToken, viewport) {
	try {
		createSqlResultGridRunMarkerBytes(expectedRunToken);
	} catch (error) {
		return failed(error instanceof Error ? error.message : String(error));
	}
	const decoded = decodePngPixels(pngBytes);
	const scaleX = decoded.width / Number(viewport?.width);
	const scaleY = decoded.height / Number(viewport?.height);
	if (!Number.isFinite(scaleX) || scaleX <= 0 || !Number.isFinite(scaleY) || scaleY <= 0) {
		return failed('viewport dimensions are invalid');
	}
	const baseX = SQL_RESULT_GRID_RUN_MARKER_LAYOUT.left * scaleX;
	const markerHeight =
		SQL_RESULT_GRID_RUN_MARKER_LAYOUT.totalRows * SQL_RESULT_GRID_RUN_MARKER_LAYOUT.cellSize * scaleY;
	const baseY = decoded.height - SQL_RESULT_GRID_RUN_MARKER_LAYOUT.bottom * scaleY - markerHeight;
	const offsets = [0, -1, 1, -2, 2];
	let lastFailure = 'marker could not be decoded';
	let expectedOriginFailure;
	for (const offsetY of offsets) {
		for (const offsetX of offsets) {
			const attempt = decodeAtOffset(decoded, baseX + offsetX, baseY + offsetY, scaleX, scaleY);
			if (!attempt.passed) {
				lastFailure = attempt.reason;
				if (offsetX === 0 && offsetY === 0) expectedOriginFailure = attempt.reason;
				continue;
			}
			const decodedRunToken = formatRunToken(attempt.bytes.subarray(SQL_RESULT_GRID_RUN_MARKER_MAGIC.length, 18));
			if (decodedRunToken !== expectedRunToken) {
				return failed(
					`marker decoded run token ${decodedRunToken}; expected ${expectedRunToken}`,
					decodedRunToken,
					attempt
				);
			}
			return {
				version: SQL_RESULT_GRID_RUN_MARKER_VERSION,
				passed: true,
				decodedRunToken,
				contrast: attempt.contrast,
				bounds: attempt.bounds,
				reason: 'run marker version, CRC, and benchmark run token match'
			};
		}
	}
	return failed(expectedOriginFailure ?? lastFailure);
}

function decodeAtOffset(decoded, baseX, baseY, scaleX, scaleY) {
	const frameSamples = [];
	for (let row = 0; row < SQL_RESULT_GRID_RUN_MARKER_LAYOUT.totalRows; row += 1) {
		for (let column = 0; column < SQL_RESULT_GRID_RUN_MARKER_LAYOUT.totalColumns; column += 1) {
			if (!isFrameCell(column, row)) continue;
			const luma = sampleCellLuma(decoded, baseX, baseY, column, row, scaleX, scaleY);
			if (luma === undefined) return { passed: false, reason: 'marker frame is outside the screenshot' };
			frameSamples.push({ expected: frameCellBit(column, row), luma });
		}
	}
	const dark = median(frameSamples.filter(sample => sample.expected === 0).map(sample => sample.luma));
	const light = median(frameSamples.filter(sample => sample.expected === 1).map(sample => sample.luma));
	const contrast = Math.round(light - dark);
	if (!Number.isFinite(contrast) || contrast < minimumFrameContrast) {
		return { passed: false, reason: `marker frame contrast ${String(contrast)} is below ${minimumFrameContrast}` };
	}
	const threshold = (dark + light) / 2;
	if (frameSamples.some(sample => Number(sample.luma > threshold) !== sample.expected)) {
		return { passed: false, reason: 'marker synchronization frame is invalid' };
	}
	const bits = [];
	for (let row = 0; row < SQL_RESULT_GRID_RUN_MARKER_LAYOUT.rows; row += 1) {
		for (let column = 0; column < SQL_RESULT_GRID_RUN_MARKER_LAYOUT.columns; column += 1) {
			const luma = sampleCellLuma(
				decoded,
				baseX,
				baseY,
				column + SQL_RESULT_GRID_RUN_MARKER_LAYOUT.frame,
				row + SQL_RESULT_GRID_RUN_MARKER_LAYOUT.frame,
				scaleX,
				scaleY
			);
			if (luma === undefined) return { passed: false, reason: 'marker payload is outside the screenshot' };
			bits.push(Number(luma > threshold));
		}
	}
	const bytes = Uint8Array.from({ length: bits.length / 8 }, (_, byteIndex) =>
		bits.slice(byteIndex * 8, byteIndex * 8 + 8).reduce((value, bit) => (value << 1) | bit, 0)
	);
	if (!SQL_RESULT_GRID_RUN_MARKER_MAGIC.every((byte, index) => bytes[index] === byte)) {
		return { passed: false, reason: 'marker magic or version is invalid' };
	}
	const expectedChecksum = crc16Ccitt(bytes.subarray(0, bytes.byteLength - 2));
	const observedChecksum = (bytes.at(-2) << 8) | bytes.at(-1);
	if (observedChecksum !== expectedChecksum) {
		return { passed: false, reason: 'marker CRC is invalid' };
	}
	return {
		passed: true,
		bytes,
		contrast,
		bounds: {
			x: Math.round(baseX),
			y: Math.round(baseY),
			width: Math.round(
				SQL_RESULT_GRID_RUN_MARKER_LAYOUT.totalColumns * SQL_RESULT_GRID_RUN_MARKER_LAYOUT.cellSize * scaleX
			),
			height: Math.round(
				SQL_RESULT_GRID_RUN_MARKER_LAYOUT.totalRows * SQL_RESULT_GRID_RUN_MARKER_LAYOUT.cellSize * scaleY
			)
		}
	};
}

function sampleCellLuma(decoded, baseX, baseY, column, row, scaleX, scaleY) {
	const x = Math.floor(baseX + (column + 0.5) * SQL_RESULT_GRID_RUN_MARKER_LAYOUT.cellSize * scaleX);
	const y = Math.floor(baseY + (row + 0.5) * SQL_RESULT_GRID_RUN_MARKER_LAYOUT.cellSize * scaleY);
	if (x < 0 || x >= decoded.width || y < 0 || y >= decoded.height) return undefined;
	const [red, green, blue, alpha] = readDecodedPngPixel(decoded, x, y);
	if (alpha < 224) return undefined;
	return Math.round((red * 299 + green * 587 + blue * 114) / 1_000);
}

function isFrameCell(column, row) {
	return (
		column === 0 ||
		row === 0 ||
		column === SQL_RESULT_GRID_RUN_MARKER_LAYOUT.totalColumns - 1 ||
		row === SQL_RESULT_GRID_RUN_MARKER_LAYOUT.totalRows - 1
	);
}

function frameCellBit(column, row) {
	return (column + row) % 2;
}

function formatRunToken(bytes) {
	const hex = Buffer.from(bytes).toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function crc16Ccitt(bytes) {
	let checksum = 0xffff;
	for (const byte of bytes) {
		checksum ^= byte << 8;
		for (let bit = 0; bit < 8; bit += 1) {
			checksum = ((checksum << 1) ^ (checksum & 0x8000 ? 0x1021 : 0)) & 0xffff;
		}
	}
	return checksum;
}

function median(values) {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)];
}

function failed(reason, decodedRunToken, attempt) {
	return {
		version: SQL_RESULT_GRID_RUN_MARKER_VERSION,
		passed: false,
		decodedRunToken,
		contrast: attempt?.contrast,
		bounds: attempt?.bounds,
		reason
	};
}
