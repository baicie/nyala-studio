/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product bootstrap contribution.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { createSqlProductStartupPlan, SqlProductStartupCommand } from '../common/sqlProductBootstrapModel.js';
import { SQL_PRODUCT_BOOTSTRAPPED_STORAGE_KEY, SQL_PRODUCT_NAME } from '../common/sqlProduct.js';
import { ISqlProductPreferencesService } from '../common/sqlProductPreferencesService.js';

export class SqlProductBootstrapContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@ISqlProductPreferencesService private readonly preferencesService: ISqlProductPreferencesService
	) {
		super();

		this.bootstrap().catch(error => {
			const message = error instanceof Error ? error.message : String(error);
			this.notificationService.warn(`${SQL_PRODUCT_NAME} startup layout was not fully restored: ${message}`);
		});
	}

	private async bootstrap(): Promise<void> {
		const alreadyBootstrapped =
			this.storageService.getBoolean(SQL_PRODUCT_BOOTSTRAPPED_STORAGE_KEY, StorageScope.PROFILE, false) === true;

		const plan = createSqlProductStartupPlan({
			alreadyBootstrapped,
			preferences: this.preferencesService.preferences
		});

		await this.runPlan(plan);

		if (!alreadyBootstrapped) {
			this.storageService.store(SQL_PRODUCT_BOOTSTRAPPED_STORAGE_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
		}
	}

	private async runPlan(plan: readonly SqlProductStartupCommand[]): Promise<void> {
		for (const item of plan) {
			await this.commandService.executeCommand(item.commandId, ...(item.args ?? []));
		}
	}
}
