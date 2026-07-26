/*---------------------------------------------------------------------------------------------
 * Nyala Studio - Connection service (Phase 01 / V2).
 *
 * Operates on the new ConnectionProfile / ConnectionSecret model. The
 * legacy SqlConnectionService (Phase 00) is untouched; both services
 * can be registered side by side so the existing UI keeps working.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { Emitter, Event } from 'vs/base/common/event';
import {
	ConnectionProfile,
	ConnectionSecret,
	IConnectionWithStatus,
	ISqlConnectionServiceV2,
	ConnectionStatus
} from '../common/sqlConnection.js';
import { SqlServiceError, ISqlCommandExecutor, TauriSqlCommandExecutor } from './sqlCommandExecutor.js';

export class SqlConnectionServiceV2 extends Disposable implements ISqlConnectionServiceV2 {
	declare readonly _serviceBrand: undefined;

	private readonly _onChange = this._register(new Emitter<void>());
	private profiles: IConnectionWithStatus[] = [];

	constructor(private readonly executor: ISqlCommandExecutor = new TauriSqlCommandExecutor()) {
		super();
	}

	readonly onChange: Event<void> = this._onChange.event;

	async list(): Promise<IConnectionWithStatus[]> {
		const dtos = await this.executor.execute<ConnectionProfile[]>('sql_list_connections_v2');
		this.profiles = dtos.map(profile => this.toWithStatus(profile, { kind: 'idle' }));
		// `list` is the read path used by connection-tree rebuilds. Emitting
		// from here would cause a subscriber that calls `list()` to recursively
		// schedule another rebuild. Mutating operations below own change events.
		return this.profiles.slice();
	}

	async test(profile: ConnectionProfile, secret: ConnectionSecret): Promise<void> {
		await this.executor.execute<void>('sql_test_connection_v2', { profile, secret }, { allowVoid: true });
	}

	async open(profile: ConnectionProfile, secret: ConnectionSecret): Promise<string> {
		const id = await this.executor.execute<string>('sql_open_connection_v2', { profile, secret });
		const existing = this.profiles.findIndex(entry => entry.profile.id === profile.id);
		const next: IConnectionWithStatus = this.toWithStatus(profile, { kind: 'open' });
		if (existing >= 0) {
			this.profiles[existing] = next;
		} else {
			this.profiles.push(next);
		}
		this._onChange.fire();
		return id;
	}

	async close(profileId: string): Promise<void> {
		await this.executor.execute<void>('sql_close_connection_v2', { profileId }, { allowVoid: true });
		const existing = this.profiles.findIndex(entry => entry.profile.id === profileId);
		if (existing >= 0) {
			this.profiles[existing] = this.toWithStatus(this.profiles[existing].profile, { kind: 'idle' });
		}
		this._onChange.fire();
	}

	async forgetAllSecrets(): Promise<void> {
		await this.executor.execute<void>('sql_forget_secrets', undefined, { allowVoid: true });
		this.profiles = this.profiles.map(entry => this.toWithStatus(entry.profile, { kind: 'idle' }));
		this._onChange.fire();
	}

	private toWithStatus(profile: ConnectionProfile, status: ConnectionStatus): IConnectionWithStatus {
		return { profile, status };
	}
}

/**
 * Defensive helper that wraps a thrown error so consumers can render a
 * structured message without leaking the secret. The shape mirrors
 * `SqlCommandError` from the Rust side (Phase 01).
 */
export function asStructuredConnectionError(command: string, error: unknown): { code: string; message: string } {
	if (error instanceof SqlServiceError) {
		return { code: 'sql_service_error', message: `${command}: ${error.message}` };
	}
	if (error instanceof Error) {
		return { code: 'connection_error', message: `${command}: ${error.message}` };
	}
	return { code: 'connection_error', message: `${command}: ${String(error)}` };
}
