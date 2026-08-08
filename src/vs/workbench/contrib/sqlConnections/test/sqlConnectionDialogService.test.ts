/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection editor coordinator tests.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IEditorPane } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { SqlConnectionEditorInput } from '../../../services/sql/common/sqlConnectionEditorInput.js';
import { SqlConnectionKind, SqlSavedConnection } from '../../../services/sql/common/sqlTypes.js';
import { SQL_CONNECTION_EDITOR_MODAL_SIZE, SqlConnectionDialogService } from '../browser/sqlConnectionDialogService.js';

test('connection dialog opens a sized modal editor and waits for disposal', async () => {
	let openedInput: SqlConnectionEditorInput | undefined;
	let openedOptions: IEditorOptions | undefined;
	let openCalls = 0;
	const editorService = {
		openEditor: async (input: SqlConnectionEditorInput, options: IEditorOptions) => {
			openCalls++;
			openedInput = input;
			openedOptions = options;
			return {} as IEditorPane;
		}
	} as unknown as IEditorService;
	const service = new SqlConnectionDialogService(editorService);

	const pending = service.openNew(SqlConnectionKind.MySql);
	const concurrent = service.openNew(SqlConnectionKind.Sqlite);

	assert.equal(pending, concurrent);
	assert.equal(openCalls, 1);
	assert.equal(openedInput?.request.mode, 'new');
	assert.equal(openedInput?.request.initialKind, SqlConnectionKind.MySql);
	assert.equal(openedOptions?.pinned, true);
	assert.deepEqual(openedOptions?.modal?.size, SQL_CONNECTION_EDITOR_MODAL_SIZE);

	let settled = false;
	pending.then(() => {
		settled = true;
	});
	await Promise.resolve();
	assert.equal(settled, false);

	openedInput?.dispose();
	await pending;
	assert.equal(settled, true);

	service.dispose();
});

test('saved dialog request strips accidental secret fields before opening', async () => {
	const unsafeSaved = {
		id: 'mysql-prod',
		name: 'Production MySQL',
		kind: SqlConnectionKind.MySql,
		host: 'db.example.test',
		port: 3306,
		database: 'app',
		username: 'app_user',
		readOnly: false,
		createIfMissing: false,
		autoConnect: false,
		password: 'do-not-store'
	} as SqlSavedConnection & { password: string };
	let openedInput: SqlConnectionEditorInput | undefined;
	const editorService = {
		openEditor: async (input: SqlConnectionEditorInput) => {
			openedInput = input;
			return {} as IEditorPane;
		}
	} as unknown as IEditorService;
	const service = new SqlConnectionDialogService(editorService);

	const pending = service.openSaved(unsafeSaved);
	assert.equal(openedInput?.request.mode, 'saved');
	assert.equal('password' in openedInput!.request.saved, false);
	assert.equal(JSON.stringify(openedInput?.request).includes('do-not-store'), false);

	openedInput?.dispose();
	await pending;
	service.dispose();
});

test('rejected or missing editor opens release the dialog gate', async () => {
	let call = 0;
	let firstInput: SqlConnectionEditorInput | undefined;
	const editorService = {
		openEditor: async (input: SqlConnectionEditorInput) => {
			call++;
			firstInput ??= input;
			if (call === 1) {
				throw new Error('open failed');
			}
			return undefined;
		}
	} as unknown as IEditorService;
	const service = new SqlConnectionDialogService(editorService);

	await assert.rejects(() => service.openNew(), /open failed/);
	assert.equal(firstInput?.isDisposed(), true);

	await service.openNew(SqlConnectionKind.MySql);
	assert.equal(call, 2);

	service.dispose();
});
