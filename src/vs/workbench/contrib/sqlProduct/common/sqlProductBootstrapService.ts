import { DeferredPromise } from '../../../../base/common/async.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { SqlProductStartupCommandKind } from './sqlProductBootstrapModel.js';

export type SqlProductBootstrapMode = 'onboarding' | 'restore';
export type SqlProductBootstrapStatus = 'succeeded' | 'failed' | 'disposed';
export type SqlProductBootstrapFailedStep = 'prepare' | SqlProductStartupCommandKind | 'persist';

export interface SqlProductBootstrapOutcome {
	readonly version: 1;
	readonly status: SqlProductBootstrapStatus;
	readonly mode: SqlProductBootstrapMode;
	readonly completedCommands: readonly SqlProductStartupCommandKind[];
	readonly failedStep?: SqlProductBootstrapFailedStep;
	readonly errorCode?: string;
}

export const ISqlProductBootstrapService = createDecorator<ISqlProductBootstrapService>('sqlProductBootstrapService');

export interface ISqlProductBootstrapService {
	readonly _serviceBrand: undefined;
	readonly whenSettled: Promise<SqlProductBootstrapOutcome>;

	start(mode: SqlProductBootstrapMode, taskFactory: () => Promise<SqlProductBootstrapOutcome>): void;
	settleDisposed(mode: SqlProductBootstrapMode): void;
}

export class SqlProductBootstrapService implements ISqlProductBootstrapService {
	declare readonly _serviceBrand: undefined;

	private readonly completion = new DeferredPromise<SqlProductBootstrapOutcome>();
	private started = false;
	private disposed = false;

	readonly whenSettled = this.completion.p;

	start(mode: SqlProductBootstrapMode, taskFactory: () => Promise<SqlProductBootstrapOutcome>): void {
		if (this.started) {
			throw new Error('SQL Product bootstrap already started.');
		}
		if (this.disposed) {
			throw new Error('SQL Product bootstrap already disposed.');
		}

		this.started = true;
		let task: Promise<SqlProductBootstrapOutcome>;
		try {
			task = taskFactory();
		} catch {
			this.completeUnexpectedFailure(mode);
			return;
		}

		void task.then(
			outcome => this.completion.complete(outcome),
			() => this.completeUnexpectedFailure(mode)
		);
	}

	settleDisposed(mode: SqlProductBootstrapMode): void {
		this.disposed = true;
		void this.completion.complete({
			version: 1,
			status: 'disposed',
			mode,
			completedCommands: []
		});
	}

	private completeUnexpectedFailure(mode: SqlProductBootstrapMode): Promise<void> {
		return this.completion.complete({
			version: 1,
			status: 'failed',
			mode,
			completedCommands: [],
			failedStep: 'prepare',
			errorCode: 'unexpected-bootstrap-rejection'
		});
	}
}
