import { readFile, writeFile } from 'node:fs/promises';

const FIXED_CAPACITY_EXPRESSION = 'Math.ceil(f/n)+r*2+1';
const REDUCED_CAPACITY_EXPRESSION = 'Math.ceil(f/n)+1';

export function patchFixedCapacityBundle(source) {
	const matches = source.split(FIXED_CAPACITY_EXPRESSION).length - 1;
	if (matches !== 1) {
		throw new Error(`Expected exactly one fixed-capacity expression, found ${matches}.`);
	}

	return source.replace(FIXED_CAPACITY_EXPRESSION, REDUCED_CAPACITY_EXPRESSION);
}

const inputPath = process.argv[2];
if (inputPath) {
	const source = await readFile(inputPath, 'utf8');
	await writeFile(inputPath, patchFixedCapacityBundle(source), 'utf8');
}
