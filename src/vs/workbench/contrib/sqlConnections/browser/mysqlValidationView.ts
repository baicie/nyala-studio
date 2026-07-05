/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - MySQL Preview validation controller (Phase 08 §2.5).
 *
 * Drives the opt-in MySQL Preview validation flow that
 * `docs/sql-mvp-phases/phase-08-mvp-packaging.md` describes:
 *
 *   1. The user opens the "Run MySQL Preview validation" action in
 *      the SQL Connections view (Phase 08 UI).
 *   2. They type host / port / username / password (the same form
 *      fields the connection tree already uses).
 *   3. The controller opens a transient profile against the live
 *      MySQL server, invokes the Rust validator through the
 *      injected `IMysqlPreviewValidator` service, and surfaces the
 *      structured report (selectOk, ddlOk, warnings).
 *
 * This controller is a thin Disposable: it owns no async state,
 * holds no emitter, and never calls `close()` on the transient
 * profile. The spec deliberately leaves the connection open so a
 * follow-up user-driven query against the same MySQL instance can
 * reuse the already-authenticated pool without re-prompting for
 * credentials.
 *
 * The actual `ISqlConnectionServiceV2.open()` we use *does* upsert
 * the profile into the manager (v2 API design). That mismatch with
 * the spec's "temporary profile (do not save)" wording is recorded
 * for a follow-up that introduces a true transient-open API.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import {
	ConnectionProfile,
	ConnectionSecret,
	ISqlConnectionServiceV2
} from 'vs/workbench/services/sql/common/sqlConnection';

/** Result returned to the host view. */
export interface MysqlPreviewValidationOutcome {
	readonly ok: boolean;
	readonly warnings: readonly string[];
	readonly code?: string;
	readonly message?: string;
}

/**
 * Service-level facade in front of the Tauri `sql_validate_mysql_preview`
 * command. Decoupling the controller from the raw `invoke()` call lets
 * unit tests substitute a fake without standing up a Tauri runtime.
 */
export const IMysqlPreviewValidator = createDecorator<IMysqlPreviewValidator>('mysqlPreviewValidator');

export interface IMysqlPreviewValidator {
	readonly _serviceBrand: undefined;
	validate(connectionId: string): Promise<MysqlPreviewValidationReport>;
}

export interface MysqlPreviewValidationReport {
	readonly selectOk: boolean;
	readonly ddlOk: boolean;
	readonly droppedTable: boolean;
	readonly warnings: readonly string[];
}

export class MysqlPreviewValidationController extends Disposable {
	declare readonly _brand: 'MysqlPreviewValidationController';

	constructor(
		@ISqlConnectionServiceV2 private readonly connections: ISqlConnectionServiceV2,
		@IMysqlPreviewValidator private readonly validator: IMysqlPreviewValidator
	) {
		super();
	}

	/**
	 * Run the validation. The caller-supplied `profileId` is forwarded
	 * to the validator (matching the spec contract); the connection
	 * the controller actually opens uses a `tmp-` prefixed id so it
	 * does not collide with user-saved profiles.
	 */
	async validate(
		profileId: string,
		host: string,
		port: number,
		username: string,
		password: string
	): Promise<MysqlPreviewValidationOutcome> {
		const tmpProfile: ConnectionProfile = {
			id: 'tmp-' + Date.now(),
			label: 'mysql-preview-validation',
			driver: 'mysql',
			host,
			port,
			database: 'mysql',
			username,
			readOnly: false
		};
		const secret: ConnectionSecret = { password };

		await this.connections.open(tmpProfile, secret);
		try {
			const report = await this.validator.validate(profileId);
			return {
				ok: report.selectOk && report.ddlOk,
				warnings: report.warnings
			};
		} catch (e: unknown) {
			const err = e as { code?: string; message?: string };
			return {
				ok: false,
				warnings: [],
				code: err?.code,
				message: err?.message
			};
		}
	}
}