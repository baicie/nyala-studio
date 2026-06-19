/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor -> SQL Query History bridge.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ISqlEditorEventService } from '../../sqlEditor/common/sqlEditorEvents.js';
import { ISqlQueryHistoryService } from '../common/sqlQueryHistoryService.js';

export class SqlQueryHistoryBridgeContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@ISqlEditorEventService sqlEditorEventService: ISqlEditorEventService,
		@ISqlQueryHistoryService sqlQueryHistoryService: ISqlQueryHistoryService
	) {
		super();

		this._register(sqlEditorEventService.onDidCompleteQuery(event => sqlQueryHistoryService.addCompletedQuery(event)));
		this._register(sqlEditorEventService.onDidFailQuery(event => sqlQueryHistoryService.addFailedQuery(event)));
	}
}
