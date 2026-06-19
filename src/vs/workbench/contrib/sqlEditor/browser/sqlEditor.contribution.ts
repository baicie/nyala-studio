/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor workbench contribution.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlEditor.css';

import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { EditorExtensions } from '../../../common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { Extensions as WorkbenchExtensions, IWorkbenchContributionsRegistry, WorkbenchPhase } from '../../../common/contributions.js';
import { ISqlEditorDraftService, SqlEditorDraftService } from '../common/sqlEditorDraftService.js';
import { ISqlEditorEventService, SqlEditorEventService } from '../common/sqlEditorEvents.js';
import { SQL_EDITOR_PANE_ID } from '../common/sqlEditor.js';
import { SqlEditorInput } from '../common/sqlEditorInput.js';
import { SqlEditorDraftRestoreContribution } from './sqlEditorDraftRestore.js';
import { SqlEditorPane } from './sqlEditorPane.js';
import './sqlEditorActions.js';

registerSingleton(ISqlEditorEventService, SqlEditorEventService, InstantiationType.Delayed);
registerSingleton(ISqlEditorDraftService, SqlEditorDraftService, InstantiationType.Delayed);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(SqlEditorPane, SQL_EDITOR_PANE_ID, 'SQL Query Editor'),
	[new SyncDescriptor(SqlEditorInput)]
);

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution2(
	'workbench.contrib.sqlEditorDraftRestore',
	SqlEditorDraftRestoreContribution,
	WorkbenchPhase.AfterRestored
);
