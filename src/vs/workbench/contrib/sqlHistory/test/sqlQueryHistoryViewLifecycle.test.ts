import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import ts from 'typescript';

function getInstancePropertyNames(sourceUrl: URL, className: string): string[] {
	const source = readFileSync(sourceUrl, 'utf8');
	const sourceFile = ts.createSourceFile(sourceUrl.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const declaration = sourceFile.statements.find(
		(statement): statement is ts.ClassDeclaration =>
			ts.isClassDeclaration(statement) && statement.name?.text === className
	);

	assert.ok(declaration, `class ${className} must exist`);

	return declaration.members
		.filter(ts.isPropertyDeclaration)
		.filter(member => !member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword))
		.map(member => member.name)
		.filter((name): name is ts.Identifier | ts.StringLiteral => ts.isIdentifier(name) || ts.isStringLiteral(name))
		.map(name => name.text);
}

test('SqlQueryHistoryView does not shadow ViewPane instance state', () => {
	const viewPaneProperties = new Set(
		getInstancePropertyNames(new URL('../../../browser/parts/views/viewPane.ts', import.meta.url), 'ViewPane')
	);
	const historyViewProperties = getInstancePropertyNames(
		new URL('../browser/sqlQueryHistoryView.ts', import.meta.url),
		'SqlQueryHistoryView'
	);
	const collisions = historyViewProperties.filter(property => viewPaneProperties.has(property));

	assert.deepEqual(collisions, [], `subclass fields overwrite ViewPane runtime state: ${collisions.join(', ')}`);
});
