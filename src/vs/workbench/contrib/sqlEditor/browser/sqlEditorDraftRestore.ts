/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor draft restore contribution.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ISqlEditorDraftService } from '../common/sqlEditorDraftService.js';
import { SqlEditorInput } from '../common/sqlEditorInput.js';

export class SqlEditorDraftRestoreContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@ISqlEditorDraftService draftService: ISqlEditorDraftService,
		@IEditorService editorService: IEditorService
	) {
		super();

		this.restoreDrafts(draftService, editorService).catch(() => undefined);
	}

	private async restoreDrafts(
		draftService: ISqlEditorDraftService,
		editorService: IEditorService
	): Promise<void> {
		for (const draft of draftService.entries) {
			await editorService.openEditor(
				new SqlEditorInput({
					id: draft.id,
					connectionId: draft.connectionId,
					connectionName: draft.connectionName,
					initialSql: draft.sql
				}),
				{
					pinned: false,
					inactive: true
				}
			);
		}
	}
}
