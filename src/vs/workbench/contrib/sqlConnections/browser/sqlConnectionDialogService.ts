/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection editor coordinator.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import {
	createNewSqlConnectionDialogRequest,
	createSavedSqlConnectionDialogRequest,
	ISqlConnectionDialogService,
	normalizeSqlConnectionDialogRequest,
	SqlConnectionDialogGate,
	SqlConnectionDialogRequest
} from '../../../services/sql/common/sqlConnectionDialog.js';
import { SqlConnectionEditorInput } from '../../../services/sql/common/sqlConnectionEditorInput.js';
import { SqlConnectionKind, SqlSavedConnection } from '../../../services/sql/common/sqlTypes.js';

/**
 * Default dimensions for the settings-style connection editor. The modal
 * editor part clamps this size to the available workbench viewport.
 */
export const SQL_CONNECTION_EDITOR_MODAL_SIZE = Object.freeze({
	width: 1040,
	height: 720
});

export class SqlConnectionDialogService extends Disposable implements ISqlConnectionDialogService {
	declare readonly _serviceBrand: undefined;

	private readonly gate = new SqlConnectionDialogGate<void>();

	constructor(@IEditorService private readonly editorService: IEditorService) {
		super();
	}

	open(request: SqlConnectionDialogRequest): Promise<void> {
		const normalizedRequest = normalizeSqlConnectionDialogRequest(request);
		return this.gate.run(() => this.openEditor(normalizedRequest));
	}

	openNew(kind: SqlConnectionKind = SqlConnectionKind.Sqlite): Promise<void> {
		return this.open(createNewSqlConnectionDialogRequest(kind));
	}

	openSaved(saved: SqlSavedConnection): Promise<void> {
		return this.open(createSavedSqlConnectionDialogRequest(saved));
	}

	private async openEditor(request: SqlConnectionDialogRequest): Promise<void> {
		const input = new SqlConnectionEditorInput(request);
		const whenDisposed = Event.toPromise(input.onWillDispose);

		try {
			const pane = await this.editorService.openEditor(input, {
				pinned: true,
				modal: {
					size: SQL_CONNECTION_EDITOR_MODAL_SIZE
				}
			});

			// A missing pane means the input was not accepted (for example while
			// the editor contribution is still loading). Do not leave a detached
			// input or a permanently occupied gate behind.
			if (!pane) {
				input.dispose();
				return;
			}

			// The caller's operation represents the whole modal interaction, not
			// merely the asynchronous open call. The pane owns disposal on close.
			await whenDisposed;
		} catch (error) {
			if (!input.isDisposed()) {
				input.dispose();
			}
			throw error;
		}
	}
}
