/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product bootstrap contribution.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { SQL_PRODUCT_BOOTSTRAPPED_STORAGE_KEY, SQL_PRODUCT_NAME } from '../common/sqlProduct.js';
import {
	createSqlProductStartupPlan,
	SqlProductStartupCommand,
	SqlProductStartupCommandKind
} from '../common/sqlProductBootstrapModel.js';
import {
	ISqlProductBootstrapService,
	SqlProductBootstrapMode,
	SqlProductBootstrapOutcome
} from '../common/sqlProductBootstrapService.js';
import { ISqlProductPreferencesService } from '../common/sqlProductPreferencesService.js';

export class SqlProductBootstrapContribution extends Disposable implements IWorkbenchContribution {
	private disposed = false;
	private mode: SqlProductBootstrapMode = 'onboarding';

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@ISqlProductPreferencesService private readonly preferencesService: ISqlProductPreferencesService,
		@ISqlProductBootstrapService private readonly bootstrapService: ISqlProductBootstrapService
	) {
		super();

		let alreadyBootstrapped: boolean;
		try {
			alreadyBootstrapped =
				this.storageService.getBoolean(SQL_PRODUCT_BOOTSTRAPPED_STORAGE_KEY, StorageScope.PROFILE, false) === true;
		} catch (error) {
			this.bootstrapService.start(this.mode, () =>
				Promise.resolve(this.failure([], 'prepare', 'startup-prepare-failed', error))
			);
			return;
		}

		this.mode = alreadyBootstrapped ? 'restore' : 'onboarding';
		this.bootstrapService.start(this.mode, () => this.bootstrap(alreadyBootstrapped));
	}

	override dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.bootstrapService.settleDisposed(this.mode);
		super.dispose();
	}

	private async bootstrap(alreadyBootstrapped: boolean): Promise<SqlProductBootstrapOutcome> {
		let plan: readonly SqlProductStartupCommand[];
		try {
			plan = createSqlProductStartupPlan({
				alreadyBootstrapped,
				preferences: this.preferencesService.preferences
			});
		} catch (error) {
			return this.failure([], 'prepare', 'startup-prepare-failed', error);
		}

		const completedCommands: SqlProductStartupCommandKind[] = [];
		for (const item of plan) {
			if (this.disposed) {
				return this.disposedOutcome(completedCommands);
			}
			try {
				await this.commandService.executeCommand(item.commandId, ...this.startupCommandArgs(item));
			} catch (error) {
				return this.disposed
					? this.disposedOutcome(completedCommands)
					: this.failure(completedCommands, item.kind, 'startup-command-failed', error);
			}
			if (this.disposed) {
				return this.disposedOutcome(completedCommands);
			}
			completedCommands.push(item.kind);
		}

		if (!alreadyBootstrapped) {
			if (this.disposed) {
				return this.disposedOutcome(completedCommands);
			}
			try {
				this.storageService.store(SQL_PRODUCT_BOOTSTRAPPED_STORAGE_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
			} catch (error) {
				return this.failure(completedCommands, 'persist', 'bootstrap-persist-failed', error);
			}
		}

		return {
			version: 1,
			status: 'succeeded',
			mode: this.mode,
			completedCommands
		};
	}

	private startupCommandArgs(item: SqlProductStartupCommand): unknown[] {
		if (item.kind !== SqlProductStartupCommandKind.BootstrapDemo) {
			return item.args ?? [];
		}
		const options = item.args?.[0];
		return [
			{
				...(options && typeof options === 'object' ? options : {}),
				suppressErrorNotification: true
			}
		];
	}

	private failure(
		completedCommands: readonly SqlProductStartupCommandKind[],
		failedStep: 'prepare' | SqlProductStartupCommandKind | 'persist',
		errorCode: string,
		error: unknown
	): SqlProductBootstrapOutcome {
		if (this.disposed) {
			return this.disposedOutcome(completedCommands);
		}
		const message = error instanceof Error ? error.message : String(error);
		this.notificationService.warn(`${SQL_PRODUCT_NAME} startup initialization did not complete: ${message}`);
		return {
			version: 1,
			status: 'failed',
			mode: this.mode,
			completedCommands: [...completedCommands],
			failedStep,
			errorCode
		};
	}

	private disposedOutcome(completedCommands: readonly SqlProductStartupCommandKind[]): SqlProductBootstrapOutcome {
		return {
			version: 1,
			status: 'disposed',
			mode: this.mode,
			completedCommands: [...completedCommands]
		};
	}
}
