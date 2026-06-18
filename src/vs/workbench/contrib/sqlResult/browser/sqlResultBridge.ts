/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor -> SQL Result bridge.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ISqlEditorEventService } from '../../sqlEditor/common/sqlEditorEvents.js';
import { ISqlResultService } from '../common/sqlResultService.js';

export class SqlResultBridgeContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@ISqlEditorEventService sqlEditorEventService: ISqlEditorEventService,
		@ISqlResultService sqlResultService: ISqlResultService
	) {
		super();

		this._register(sqlEditorEventService.onDidStartQuery(event => sqlResultService.setRunning(event)));
		this._register(sqlEditorEventService.onDidCompleteQuery(event => sqlResultService.setSuccess(event)));
		this._register(sqlEditorEventService.onDidFailQuery(event => sqlResultService.setError(event)));
	}
}
