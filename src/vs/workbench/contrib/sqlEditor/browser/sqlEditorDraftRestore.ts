/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor draft restore contribution.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ISqlProductPreferencesService } from '../../sqlProduct/common/sqlProductPreferencesService.js';
import { ISqlEditorDraftService } from '../common/sqlEditorDraftService.js';
import { SqlEditorInput } from '../common/sqlEditorInput.js';
import { limitRestoredDrafts } from '../../sqlProduct/common/sqlProductIntegrationModel.js';

export class SqlEditorDraftRestoreContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@ISqlEditorDraftService draftService: ISqlEditorDraftService,
		@IEditorService editorService: IEditorService,
		@ISqlProductPreferencesService preferencesService: ISqlProductPreferencesService
	) {
		super();

		this.restoreDrafts(draftService, editorService, preferencesService).catch(() => undefined);
	}

	private async restoreDrafts(
		draftService: ISqlEditorDraftService,
		editorService: IEditorService,
		preferencesService: ISqlProductPreferencesService
	): Promise<void> {
		const drafts = limitRestoredDrafts(draftService.entries, preferencesService.preferences);

		for (const draft of drafts) {
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
