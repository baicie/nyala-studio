/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Editor input.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorInputCapabilities, IUntypedEditorInput, Verbosity } from '../../../common/editor.js';
import {
	SQL_EDITOR_DEFAULT_QUERY,
	SQL_EDITOR_INPUT_TYPE_ID,
	SQL_EDITOR_PANE_ID,
	SQL_EDITOR_SCHEME
} from './sqlEditor.js';
import {
	getSqlEditorDescription,
	getSqlEditorName,
	normalizeSqlEditorOptions,
	SqlEditorOptions
} from './sqlEditorModel.js';

export class SqlEditorInput extends EditorInput {
	static readonly TYPE_ID = SQL_EDITOR_INPUT_TYPE_ID;
	static readonly EDITOR_ID = SQL_EDITOR_PANE_ID;

	readonly id: string;
	readonly connectionId?: string;
	readonly connectionName?: string;
	readonly initialSql: string;
	readonly resource: URI;

	constructor(options: SqlEditorOptions = {}) {
		super();

		const normalized = normalizeSqlEditorOptions(
			options,
			SQL_EDITOR_DEFAULT_QUERY,
			() => `query-${Date.now()}-${Math.random().toString(16).slice(2)}`
		);

		this.id = normalized.id;
		this.connectionId = normalized.connectionId;
		this.connectionName = normalized.connectionName;
		this.initialSql = normalized.initialSql;
		this.resource = URI.from({
			scheme: SQL_EDITOR_SCHEME,
			path: `/${encodeURIComponent(this.id)}.sql`
		});
	}

	override get typeId(): string {
		return SqlEditorInput.TYPE_ID;
	}

	override get editorId(): string {
		return SqlEditorInput.EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Scratchpad | EditorInputCapabilities.CanSplitInGroup;
	}

	override getName(): string {
		return getSqlEditorName(this.connectionName);
	}

	override getDescription(_verbosity?: Verbosity): string | undefined {
		return getSqlEditorDescription(this.connectionId);
	}

	override getTitle(_verbosity?: Verbosity): string {
		const description = this.getDescription();

		if (!description) {
			return this.getName();
		}

		return `${this.getName()} — ${description}`;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		if (otherInput instanceof SqlEditorInput) {
			return otherInput.id === this.id;
		}

		return super.matches(otherInput);
	}

	override copy(): EditorInput {
		return new SqlEditorInput({
			id: this.id,
			connectionId: this.connectionId,
			connectionName: this.connectionName,
			initialSql: this.initialSql
		});
	}
}
