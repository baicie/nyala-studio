/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL connection editor input.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IUntypedEditorInput, Verbosity } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import {
	isSavedSqlConnectionDialogRequest,
	normalizeSqlConnectionDialogRequest,
	SqlConnectionDialogMode,
	SqlConnectionDialogRequest
} from './sqlConnectionDialog.js';
import { getSqlDriverDescriptor } from './sqlDrivers.js';
import { SqlConnectionKind } from './sqlTypes.js';

export const SQL_CONNECTION_EDITOR_INPUT_TYPE_ID = 'workbench.input.sqlConnectionEditor';
export const SQL_CONNECTION_EDITOR_PANE_ID = 'workbench.editor.sqlConnection';
export const SQL_CONNECTION_EDITOR_SCHEME = 'nyala-sql-connection';

const SQL_CONNECTION_EDITOR_RESOURCE = URI.from({
	scheme: SQL_CONNECTION_EDITOR_SCHEME,
	path: '/data-source'
});

/**
 * A typed, transient editor input for the connection wizard.
 *
 * There is intentionally no editor serializer for this input. Connection
 * drafts contain user-entered fields and are not workspace state. The request
 * is normalized to a password-free immutable copy before it is retained.
 */
export class SqlConnectionEditorInput extends EditorInput {
	static readonly ID = SQL_CONNECTION_EDITOR_INPUT_TYPE_ID;
	static readonly TYPE_ID = SQL_CONNECTION_EDITOR_INPUT_TYPE_ID;
	static readonly EDITOR_ID = SQL_CONNECTION_EDITOR_PANE_ID;

	readonly request: SqlConnectionDialogRequest;
	readonly resource = SQL_CONNECTION_EDITOR_RESOURCE;
	private currentKind: SqlConnectionKind;

	constructor(request: SqlConnectionDialogRequest) {
		super();
		this.request = normalizeSqlConnectionDialogRequest(request);
		this.currentKind =
			this.request.mode === SqlConnectionDialogMode.New ? this.request.initialKind : this.request.saved.kind;
	}

	override get typeId(): string {
		return SqlConnectionEditorInput.TYPE_ID;
	}

	override get editorId(): string {
		return SqlConnectionEditorInput.EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return (
			super.capabilities |
			EditorInputCapabilities.Readonly |
			EditorInputCapabilities.Singleton |
			EditorInputCapabilities.RequiresModal
		);
	}

	override getName(): string {
		return isSavedSqlConnectionDialogRequest(this.request)
			? localize('sqlConnectionEditorInputEditName', 'Edit Data Source')
			: localize('sqlConnectionEditorInputNewName', 'New Data Source');
	}

	override getTitle(_verbosity?: Verbosity): string {
		return this.getName();
	}

	override getIcon(): ThemeIcon {
		return Codicon.database;
	}

	override getDescription(_verbosity?: Verbosity): string | undefined {
		return getSqlDriverDescriptor(this.currentKind).label;
	}

	setConnectorKind(kind: SqlConnectionKind): void {
		if (this.currentKind === kind) {
			return;
		}

		this.currentKind = kind;
		this._onDidChangeLabel.fire();
	}

	/** Connection drafts must not be resurrected from workspace history. */
	override canReopen(): boolean {
		return false;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		if (otherInput instanceof SqlConnectionEditorInput) {
			return this.resource.toString() === otherInput.resource.toString();
		}

		return super.matches(otherInput);
	}
}
