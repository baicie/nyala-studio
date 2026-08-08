import { Emitter } from 'vs/base/common/event';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import {
	SqlServiceError,
	ISqlCommandExecutor,
	TauriSqlCommandExecutor,
	toSqlServiceError
} from './sqlCommandExecutor.js';
import { ISqlDriverPackageService } from '../common/sqlDriverPackages.js';
import { SqlRuntimeDriverId } from '../common/sqlDriverCatalog.js';
import { SqlDriverPackage } from '../common/sqlTypes.js';

interface RawSqlDriverPackage {
	id: unknown;
	driverId: unknown;
	displayName: unknown;
	version: unknown;
	fileName: unknown;
	sizeBytes: unknown;
	installed: unknown;
}

export class SqlDriverPackageService extends Disposable implements ISqlDriverPackageService {
	declare readonly _serviceBrand: undefined;

	private cache: readonly SqlDriverPackage[] | undefined;
	private packagesLoad: Promise<readonly SqlDriverPackage[]> | undefined;
	private readonly onDidChangeEmitter = this._register(new Emitter<void>());

	constructor(private readonly executor: ISqlCommandExecutor = new TauriSqlCommandExecutor()) {
		super();
	}

	onChange(listener: () => void): IDisposable {
		return this.onDidChangeEmitter.event(listener);
	}

	getPackages(): Promise<readonly SqlDriverPackage[]> {
		return this.cache ? Promise.resolve(this.cache) : (this.packagesLoad ?? this.loadPackages());
	}

	refreshPackages(): Promise<readonly SqlDriverPackage[]> {
		if (this.packagesLoad) {
			return this.packagesLoad;
		}

		this.cache = undefined;
		return this.loadPackages();
	}

	findForDriver(driverId: SqlRuntimeDriverId): SqlDriverPackage | undefined {
		return this.cache?.find(packageEntry => packageEntry.driverId === driverId);
	}

	async download(packageId: string): Promise<SqlDriverPackage> {
		const normalizedPackageId = packageId.trim();
		if (!normalizedPackageId) {
			throw new SqlServiceError('Driver package id is required', 'sql_download_driver', undefined, 'invalid_input');
		}

		try {
			if (!this.cache) {
				// Download can still provide a useful, structured error when the
				// status probe is unavailable; the backend validates the package id.
				await this.getPackages().catch(() => undefined);
			}
			const raw = await this.executor.execute<RawSqlDriverPackage>('sql_download_driver', {
				packageId: normalizedPackageId
			});
			const downloaded = normalizePackage(raw);
			const current = this.cache ?? [];
			this.cache = Object.freeze([...current.filter(packageEntry => packageEntry.id !== downloaded.id), downloaded]);
			this.onDidChangeEmitter.fire();
			return downloaded;
		} catch (error) {
			throw toSqlServiceError('sql_download_driver', error);
		}
	}

	private loadPackages(): Promise<readonly SqlDriverPackage[]> {
		const load = this.fetchPackages().finally(() => {
			if (this.packagesLoad === load) {
				this.packagesLoad = undefined;
			}
		});
		this.packagesLoad = load;
		return load;
	}

	private async fetchPackages(): Promise<readonly SqlDriverPackage[]> {
		try {
			const raw = await this.executor.execute<RawSqlDriverPackage[]>('sql_list_driver_packages');
			if (!Array.isArray(raw)) {
				throw new Error('SQL driver package command returned a non-array result');
			}
			const packages = Object.freeze(raw.map(normalizePackage));
			this.cache = packages;
			this.onDidChangeEmitter.fire();
			return packages;
		} catch (error) {
			throw toSqlServiceError('sql_list_driver_packages', error);
		}
	}
}

function normalizePackage(raw: RawSqlDriverPackage): SqlDriverPackage {
	if (
		typeof raw.id !== 'string' ||
		typeof raw.driverId !== 'string' ||
		typeof raw.displayName !== 'string' ||
		typeof raw.version !== 'string' ||
		typeof raw.fileName !== 'string' ||
		typeof raw.sizeBytes !== 'number' ||
		!Number.isSafeInteger(raw.sizeBytes) ||
		raw.sizeBytes <= 0 ||
		typeof raw.installed !== 'boolean'
	) {
		throw new Error('SQL driver package command returned an invalid package');
	}

	const driverId = normalizeDriverId(raw.driverId);
	if (!driverId) {
		throw new Error(`SQL driver package returned an unknown driver: ${raw.driverId}`);
	}

	return Object.freeze({
		id: raw.id,
		driverId,
		displayName: raw.displayName,
		version: raw.version,
		fileName: raw.fileName,
		sizeBytes: raw.sizeBytes,
		installed: raw.installed
	});
}

function normalizeDriverId(id: string): SqlRuntimeDriverId | undefined {
	switch (id) {
		case 'sqlite':
			return SqlRuntimeDriverId.Sqlite;
		case 'mysql':
			return SqlRuntimeDriverId.MySql;
		case 'postgres':
		case 'postgresql':
			return SqlRuntimeDriverId.Postgres;
		default:
			return undefined;
	}
}
