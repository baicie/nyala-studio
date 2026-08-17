import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const formattingWorkflow = await readFile(new URL('../.github/workflows/fmt.yml', import.meta.url), 'utf8');

test('Formatting CI validates every GitHub Actions workflow with pinned actionlint', () => {
	assert.match(formattingWorkflow, /^  actionlint:$/m);
	assert.match(formattingWorkflow, /^    name: actionlint$/m);
	assert.match(formattingWorkflow, /actions\/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7\.0\.0/);
	assert.match(formattingWorkflow, /^          go-version: '1\.25\.3'$/m);
	assert.match(formattingWorkflow, /go install github\.com\/rhysd\/actionlint\/cmd\/actionlint@v1\.7\.12/);
	assert.match(formattingWorkflow, /actionlint" -no-color -shellcheck "" -pyflakes ""/);
});
