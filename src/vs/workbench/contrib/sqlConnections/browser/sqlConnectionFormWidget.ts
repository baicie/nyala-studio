/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection form widget contract (Phase 01).
 *
 * The DOM renderer of the connection form implements this interface so
 * that `SqlConnectionFormController` can be unit-tested with a fake
 * widget. This keeps DOM knowledge out of the controller.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import type { ConnectionProfile, ConnectionSecret } from 'vs/workbench/services/sql/common/sqlConnection';

export type ConnectionFormAction = 'test' | 'open';

export interface IConnectionFormWidget {
	readProfile(): ConnectionProfile;
	readSecret(): ConnectionSecret;
	clearSecret(): void;
	flashOk(code: string, message: string): void;
	flashError(code: string, message: string): void;
	close(): void;
}

export type SqlConnectionFormFactory = (host: HTMLElement) => IConnectionFormWidget;

export const ISqlConnectionFormFactory = createDecorator<SqlConnectionFormFactory>('sqlConnectionFormFactory');