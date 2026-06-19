下面给出 **Phase 9.1：Postgres Preview** 的详细设计与完整代码。

当前项目已经具备 Phase 9 地基：前端协议里已经有 `SqlConnectionKind.PostgreSql`、`host / port / database / username / password / sslMode` 等网络连接字段。 Driver Catalog 里 PostgreSQL 已经存在，但状态是 `Planned`，不是 enabled。 同时现有 Connections View 仍然是 SQLite 单表单，只渲染 `Database path / Read-only / Create if missing`。 后端/前端 validation 也已经明确只允许 SQLite，非 SQLite 会被 planned/unsupported 拦截。

所以 Phase 9.1 只做 **Postgres Preview**：

```txt id="4njkl7"
用户能在连接面板选择 PostgreSQL Preview
用户能填写 host / port / database / username / password / ssl
用户能看到 masked preview / coming soon 状态
用户不能 connect / save PostgreSQL
SQLite 原流程完全不变
Tauri 不接 Postgres 运行时
```

---

# Phase 9.1：Postgres Preview

## 目标

```txt id="jrhg8e"
1. Connections View 从 SQLite-only 表单升级为 driver-aware 表单
2. SQLite 保持可连接
3. PostgreSQL 只展示 Preview 表单
4. PostgreSQL 表单能生成 masked connection input
5. PostgreSQL Connect / Save 被禁用或明确拦截
6. 不保存 password
7. 单元测试覆盖 form model / preview / input masking / planned driver gating
```

## 不做

```txt id="lg8zju"
1. 不实现 PostgreSQL 真实连接
2. 不引入 tokio-postgres / sqlx
3. 不保存密码
4. 不实现 Secret Store
5. 不实现 PostgreSQL metadata/query
6. 不展示 MySQL UI
```

---

# 文件变化

新增：

```txt id="ur02kb"
src/vs/workbench/contrib/sqlConnections/common/sqlConnectionFormModel.ts
src/vs/workbench/contrib/sqlConnections/test/sqlConnectionFormModel.test.ts
```

修改：

```txt id="h5z9rf"
src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionsView.ts
src/vs/workbench/contrib/sqlConnections/browser/media/sqlConnections.css
package.json
```

---

# 1. 新增 `sqlConnectionFormModel.ts`

路径：

```txt id="jps5zs"
src/vs/workbench/contrib/sqlConnections/common/sqlConnectionFormModel.ts
```

```ts id="fqhr2f"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL connection form model.
 * Phase 9.1 exposes PostgreSQL as preview only.
 *--------------------------------------------------------------------------------------------*/

import {
	getSqlDriverDescriptor,
	SqlDriverAvailability
} from '../../../services/sql/common/sqlDrivers.js';
import {
	SqlConnectionInput,
	SqlConnectionKind,
	SqlSslMode
} from '../../../services/sql/common/sqlTypes.js';

export const SQL_CONNECTION_PREVIEW_KINDS: readonly SqlConnectionKind[] = [
	SqlConnectionKind.Sqlite,
	SqlConnectionKind.PostgreSql
];

export interface SqlConnectionFormState {
	readonly kind: SqlConnectionKind;
	readonly name?: string;

	readonly databasePath?: string;

	readonly host?: string;
	readonly port?: number;
	readonly database?: string;
	readonly username?: string;
	readonly password?: string;
	readonly sslMode?: SqlSslMode;

	readonly readOnly: boolean;
	readonly createIfMissing: boolean;
	readonly saveConnection: boolean;
	readonly autoConnect: boolean;
}

export interface SqlConnectionFormPreview {
	readonly kind: SqlConnectionKind;
	readonly label: string;
	readonly availability: SqlDriverAvailability;
	readonly canConnect: boolean;
	readonly canSave: boolean;
	readonly message: string;
	readonly summary: string;
	readonly input: SqlConnectionInput;
	readonly maskedInput: SqlConnectionInput;
}

export function createDefaultSqlConnectionFormState(kind: SqlConnectionKind = SqlConnectionKind.Sqlite): SqlConnectionFormState {
	switch (kind) {
		case SqlConnectionKind.Sqlite:
			return {
				kind,
				name: undefined,
				databasePath: ':memory:',
				readOnly: false,
				createIfMissing: true,
				saveConnection: false,
				autoConnect: false
			};

		case SqlConnectionKind.PostgreSql:
			return {
				kind,
				name: undefined,
				host: 'localhost',
				port: 5432,
				database: 'postgres',
				username: undefined,
				password: undefined,
				sslMode: SqlSslMode.Prefer,
				readOnly: false,
				createIfMissing: false,
				saveConnection: false,
				autoConnect: false
			};

		default:
			return {
				kind: SqlConnectionKind.Sqlite,
				name: undefined,
				databasePath: ':memory:',
				readOnly: false,
				createIfMissing: true,
				saveConnection: false,
				autoConnect: false
			};
	}
}

export function normalizeSqlConnectionFormState(input: Partial<SqlConnectionFormState>): SqlConnectionFormState {
	const kind = normalizePreviewKind(input.kind);
	const defaults = createDefaultSqlConnectionFormState(kind);

	if (kind === SqlConnectionKind.Sqlite) {
		return {
			...defaults,
			name: normalizeOptionalString(input.name),
			databasePath: normalizeOptionalString(input.databasePath) ?? defaults.databasePath,
			readOnly: input.readOnly === true,
			createIfMissing: input.createIfMissing !== false,
			saveConnection: input.saveConnection === true,
			autoConnect: input.saveConnection === true && input.autoConnect === true
		};
	}

	const port = normalizePort(input.port, defaults.port);

	return {
		...defaults,
		name: normalizeOptionalString(input.name),
		host: normalizeOptionalString(input.host) ?? defaults.host,
		port,
		database: normalizeOptionalString(input.database) ?? defaults.database,
		username: normalizeOptionalString(input.username),
		password: normalizeOptionalString(input.password),
		sslMode: normalizeSslMode(input.sslMode),
		readOnly: false,
		createIfMissing: false,
		saveConnection: false,
		autoConnect: false
	};
}

export function createSqlConnectionInputFromFormState(state: Partial<SqlConnectionFormState>): SqlConnectionInput {
	const normalized = normalizeSqlConnectionFormState(state);

	if (normalized.kind === SqlConnectionKind.Sqlite) {
		return {
			name: normalized.name,
			kind: SqlConnectionKind.Sqlite,
			databasePath: normalized.databasePath,
			readOnly: normalized.readOnly,
			createIfMissing: normalized.createIfMissing
		};
	}

	return {
		name: normalized.name,
		kind: SqlConnectionKind.PostgreSql,
		host: normalized.host,
		port: normalized.port,
		database: normalized.database,
		username: normalized.username,
		password: normalized.password,
		sslMode: normalized.sslMode,
		readOnly: false,
		createIfMissing: false
	};
}

export function maskSqlConnectionInput(input: SqlConnectionInput): SqlConnectionInput {
	const { password: _password, ...rest } = input;
	return rest;
}

export function createSqlConnectionFormPreview(state: Partial<SqlConnectionFormState>): SqlConnectionFormPreview {
	const normalized = normalizeSqlConnectionFormState(state);
	const input = createSqlConnectionInputFromFormState(normalized);
	const descriptor = getSqlDriverDescriptor(normalized.kind);
	const maskedInput = maskSqlConnectionInput(input);

	if (normalized.kind === SqlConnectionKind.Sqlite) {
		const databasePath = normalized.databasePath?.trim();

		const canConnect = Boolean(databasePath);
		const canSave = canConnect && databasePath !== ':memory:' && normalized.saveConnection;

		return {
			kind: normalized.kind,
			label: descriptor.label,
			availability: descriptor.availability,
			canConnect,
			canSave,
			message: canConnect
				? 'SQLite is ready.'
				: 'SQLite database path is required.',
			summary: databasePath ? `SQLite · ${databasePath}` : 'SQLite · missing database path',
			input,
			maskedInput
		};
	}

	return {
		kind: normalized.kind,
		label: descriptor.label,
		availability: descriptor.availability,
		canConnect: false,
		canSave: false,
		message: 'PostgreSQL is preview-only in Phase 9.1. Runtime connection is not enabled yet.',
		summary: `PostgreSQL Preview · ${normalized.host}:${normalized.port}/${normalized.database}`,
		input,
		maskedInput
	};
}

export function canSubmitSqlConnectionForm(state: Partial<SqlConnectionFormState>): boolean {
	return createSqlConnectionFormPreview(state).canConnect;
}

export function canSaveSqlConnectionForm(state: Partial<SqlConnectionFormState>): boolean {
	return createSqlConnectionFormPreview(state).canSave;
}

export function getSqlConnectionFormStatus(state: Partial<SqlConnectionFormState>): string {
	const preview = createSqlConnectionFormPreview(state);

	return `${preview.summary} · ${preview.message}`;
}

function normalizePreviewKind(kind: SqlConnectionKind | undefined): SqlConnectionKind {
	switch (kind) {
		case SqlConnectionKind.Sqlite:
		case SqlConnectionKind.PostgreSql:
			return kind;

		default:
			return SqlConnectionKind.Sqlite;
	}
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function normalizePort(value: number | undefined, fallback: number | undefined): number | undefined {
	if (value === undefined) {
		return fallback;
	}

	if (!Number.isFinite(value)) {
		return fallback;
	}

	const normalized = Math.floor(value);

	if (normalized <= 0 || normalized > 65_535) {
		return fallback;
	}

	return normalized;
}

function normalizeSslMode(value: SqlSslMode | undefined): SqlSslMode {
	switch (value) {
		case SqlSslMode.Disable:
		case SqlSslMode.Prefer:
		case SqlSslMode.Require:
			return value;

		default:
			return SqlSslMode.Prefer;
	}
}
```

---

# 2. 修改 `sqlConnectionsView.ts`

路径：

```txt id="yxmwu2"
src/vs/workbench/contrib/sqlConnections/browser/sqlConnectionsView.ts
```

## 2.1 修改 imports

增加：

```ts id="md6g13"
import { SqlSslMode } from '../../../services/sql/common/sqlTypes.js';
import {
	createDefaultSqlConnectionFormState,
	createSqlConnectionFormPreview,
	createSqlConnectionInputFromFormState,
	SQL_CONNECTION_PREVIEW_KINDS,
	SqlConnectionFormState
} from '../common/sqlConnectionFormModel.js';
```

原来 `sqlTypes` import 已有：

```ts id="6ohust"
SqlConnectionKind
```

保留即可。

---

## 2.2 新增 class 字段

在现有 form 字段附近追加：

```ts id="k5fe4p"
private driverSelect!: HTMLSelectElement;
private sqliteFieldsElement!: HTMLElement;
private postgresPreviewElement!: HTMLElement;
private hostInput!: HTMLInputElement;
private portInput!: HTMLInputElement;
private databaseInput!: HTMLInputElement;
private usernameInput!: HTMLInputElement;
private passwordInput!: HTMLInputElement;
private sslModeInput!: HTMLSelectElement;
private connectButton!: HTMLButtonElement;
private driverPreviewElement!: HTMLElement;

private currentFormKind: SqlConnectionKind = SqlConnectionKind.Sqlite;
```

当前 view 字段里只有 `nameInput/databasePathInput/readOnlyInput/createIfMissingInput/saveConnectionInput/autoConnectInput` 等 SQLite 表单字段。

---

## 2.3 修改 `renderBody()`

当前 `renderBody()` 里会直接设置：

```ts
this.databasePathInput.value = ':memory:';
this.createIfMissingInput.checked = true;
```

替换为：

```ts id="b8umz0"
const defaults = createDefaultSqlConnectionFormState(SqlConnectionKind.Sqlite);
this.applyFormState(defaults);
this.refreshDriverPreview();
```

也就是 `renderBody()` 结尾应类似：

```ts id="g70swa"
protected override renderBody(container: HTMLElement): void {
	this.body = append(container, $('.sql-connections-view'));
	this.renderConnectionForm(this.body);
	this.savedConnectionsElement = append(this.body, $('.sql-saved-connections'));
	this.messageElement = append(this.body, $('.sql-connections-message'));
	this.treeElement = append(this.body, $('.sql-connections-tree', { role: 'tree', tabIndex: 0 }));

	const defaults = createDefaultSqlConnectionFormState(SqlConnectionKind.Sqlite);
	this.applyFormState(defaults);
	this.refreshDriverPreview();

	this.refresh().catch(error => this.showError(error));
}
```

---

## 2.4 替换 `addConnectionFromForm()`

当前 `addConnectionFromForm()` 只读 `databasePath` 并构造 SQLite input。

替换为：

```ts id="h0b2gz"
async addConnectionFromForm(): Promise<void> {
	const formState = this.getFormState();
	const preview = createSqlConnectionFormPreview(formState);

	if (!preview.canConnect) {
		this.showInfo(preview.message);
		return;
	}

	if (preview.kind !== SqlConnectionKind.Sqlite) {
		this.showInfo(preview.message);
		return;
	}

	this.showInfo('Opening SQLite connection...');

	try {
		const input: SqlConnectionInput = createSqlConnectionInputFromFormState(formState);

		let connectionId: string;
		let connectionName: string;

		const shouldSave = preview.canSave;

		if (formState.saveConnection && !shouldSave) {
			this.showInfo('In-memory SQLite connections are temporary and will not be saved.');
		}

		if (shouldSave) {
			const saved = await this.sqlConnectionService.saveConnection({
				input,
				autoConnect: formState.autoConnect,
				openNow: true
			});

			connectionId = saved.id;
			connectionName = saved.name;
		} else {
			const connection = await this.sqlConnectionService.openConnection(input);

			connectionId = connection.id;
			connectionName = connection.name;
		}

		this.collapsedNodes.delete(getConnectionNodeId(connectionId));
		this.showInfo(`Connected to ${connectionName}.`);
		await this.refresh();
	} catch (error) {
		this.showError(error);
	}
}
```

---

## 2.5 替换 `renderConnectionForm()`

把当前完整 `renderConnectionForm()` 替换为：

```ts id="2jrzg5"
private renderConnectionForm(container: HTMLElement): void {
	this.form = append(container, $('form.sql-connections-form'));

	const driverLabel = append(this.form, $('label.sql-connections-field'));
	append(driverLabel, $('span', undefined, 'Driver'));
	this.driverSelect = append(
		driverLabel,
		$('select.sql-connections-input', {
			'aria-label': 'SQL driver'
		})
	) as HTMLSelectElement;

	for (const kind of SQL_CONNECTION_PREVIEW_KINDS) {
		const option = document.createElement('option');
		option.value = kind;
		option.textContent = kind === SqlConnectionKind.PostgreSql ? 'PostgreSQL Preview' : 'SQLite';
		this.driverSelect.appendChild(option);
	}

	const nameLabel = append(this.form, $('label.sql-connections-field'));
	append(nameLabel, $('span', undefined, 'Name'));
	this.nameInput = append(
		nameLabel,
		$('input.sql-connections-input', {
			type: 'text',
			placeholder: 'Local SQLite'
		})
	) as HTMLInputElement;

	this.sqliteFieldsElement = append(this.form, $('.sql-connections-driver-fields.sqlite'));

	const pathLabel = append(this.sqliteFieldsElement, $('label.sql-connections-field'));
	append(pathLabel, $('span', undefined, 'Database path'));
	this.databasePathInput = append(
		pathLabel,
		$('input.sql-connections-input', {
			type: 'text',
			placeholder: '/absolute/path/to/database.db or :memory:'
		})
	) as HTMLInputElement;

	this.postgresPreviewElement = append(this.form, $('.sql-connections-driver-fields.postgres'));

	const hostLabel = append(this.postgresPreviewElement, $('label.sql-connections-field'));
	append(hostLabel, $('span', undefined, 'Host'));
	this.hostInput = append(
		hostLabel,
		$('input.sql-connections-input', {
			type: 'text',
			placeholder: 'localhost'
		})
	) as HTMLInputElement;

	const portLabel = append(this.postgresPreviewElement, $('label.sql-connections-field'));
	append(portLabel, $('span', undefined, 'Port'));
	this.portInput = append(
		portLabel,
		$('input.sql-connections-input', {
			type: 'number',
			min: '1',
			max: '65535',
			placeholder: '5432'
		})
	) as HTMLInputElement;

	const databaseLabel = append(this.postgresPreviewElement, $('label.sql-connections-field'));
	append(databaseLabel, $('span', undefined, 'Database'));
	this.databaseInput = append(
		databaseLabel,
		$('input.sql-connections-input', {
			type: 'text',
			placeholder: 'postgres'
		})
	) as HTMLInputElement;

	const usernameLabel = append(this.postgresPreviewElement, $('label.sql-connections-field'));
	append(usernameLabel, $('span', undefined, 'Username'));
	this.usernameInput = append(
		usernameLabel,
		$('input.sql-connections-input', {
			type: 'text',
			placeholder: 'postgres'
		})
	) as HTMLInputElement;

	const passwordLabel = append(this.postgresPreviewElement, $('label.sql-connections-field'));
	append(passwordLabel, $('span', undefined, 'Password'));
	this.passwordInput = append(
		passwordLabel,
		$('input.sql-connections-input', {
			type: 'password',
			placeholder: 'Preview only; not saved'
		})
	) as HTMLInputElement;

	const sslLabel = append(this.postgresPreviewElement, $('label.sql-connections-field'));
	append(sslLabel, $('span', undefined, 'SSL mode'));
	this.sslModeInput = append(
		sslLabel,
		$('select.sql-connections-input')
	) as HTMLSelectElement;

	for (const mode of [SqlSslMode.Disable, SqlSslMode.Prefer, SqlSslMode.Require]) {
		const option = document.createElement('option');
		option.value = mode;
		option.textContent = mode;
		this.sslModeInput.appendChild(option);
	}

	const options = append(this.form, $('.sql-connections-options'));

	const readOnlyLabel = append(options, $('label.sql-connections-checkbox'));
	this.readOnlyInput = append(readOnlyLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
	append(readOnlyLabel, $('span', undefined, 'Read-only'));

	const createLabel = append(options, $('label.sql-connections-checkbox'));
	this.createIfMissingInput = append(createLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
	append(createLabel, $('span', undefined, 'Create if missing'));

	const saveLabel = append(options, $('label.sql-connections-checkbox'));
	this.saveConnectionInput = append(saveLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
	append(saveLabel, $('span', undefined, 'Save'));

	const autoConnectLabel = append(options, $('label.sql-connections-checkbox'));
	this.autoConnectInput = append(autoConnectLabel, $('input', { type: 'checkbox' })) as HTMLInputElement;
	append(autoConnectLabel, $('span', undefined, 'Auto connect'));

	this.driverPreviewElement = append(this.form, $('.sql-connection-driver-preview'));

	const actions = append(this.form, $('.sql-connections-actions'));
	this.connectButton = append(actions, $('button.sql-connections-button.primary', { type: 'submit' }, 'Connect')) as HTMLButtonElement;

	const refreshButton = append(
		actions,
		$('button.sql-connections-button', { type: 'button' }, 'Refresh')
	) as HTMLButtonElement;

	this.formDisposables.add(
		addDisposableListener(this.form, EventType.SUBMIT, event => {
			event.preventDefault();
			this.addConnectionFromForm().catch(error => this.showError(error));
		})
	);

	this.formDisposables.add(
		addDisposableListener(refreshButton, EventType.CLICK, () => {
			this.refresh().catch(error => this.showError(error));
		})
	);

	this.formDisposables.add(
		addDisposableListener(this.driverSelect, EventType.CHANGE, () => {
			this.currentFormKind = this.driverSelect.value === SqlConnectionKind.PostgreSql
				? SqlConnectionKind.PostgreSql
				: SqlConnectionKind.Sqlite;

			this.applyFormState(createDefaultSqlConnectionFormState(this.currentFormKind));
			this.refreshDriverPreview();
		})
	);

	for (const input of [
		this.nameInput,
		this.databasePathInput,
		this.hostInput,
		this.portInput,
		this.databaseInput,
		this.usernameInput,
		this.passwordInput,
		this.sslModeInput,
		this.readOnlyInput,
		this.createIfMissingInput,
		this.saveConnectionInput,
		this.autoConnectInput
	]) {
		this.formDisposables.add(
			addDisposableListener(input, EventType.CHANGE, () => this.refreshDriverPreview())
		);
	}

	this.formDisposables.add(
		addDisposableListener(this.saveConnectionInput, EventType.CHANGE, () => {
			this.autoConnectInput.disabled = !this.saveConnectionInput.checked;

			if (!this.saveConnectionInput.checked) {
				this.autoConnectInput.checked = false;
			}

			this.refreshDriverPreview();
		})
	);
}
```

---

## 2.6 新增 helper 方法

放在 `renderConnectionForm()` 后面：

```ts id="0ir0tp"
private getFormState(): SqlConnectionFormState {
	return {
		kind: this.currentFormKind,
		name: this.nameInput.value,
		databasePath: this.databasePathInput.value,
		host: this.hostInput.value,
		port: this.portInput.value ? Number(this.portInput.value) : undefined,
		database: this.databaseInput.value,
		username: this.usernameInput.value,
		password: this.passwordInput.value,
		sslMode: this.sslModeInput.value as SqlSslMode,
		readOnly: this.readOnlyInput.checked,
		createIfMissing: this.createIfMissingInput.checked,
		saveConnection: this.saveConnectionInput.checked,
		autoConnect: this.autoConnectInput.checked
	};
}

private applyFormState(state: SqlConnectionFormState): void {
	this.currentFormKind = state.kind;
	this.driverSelect.value = state.kind;

	this.nameInput.value = state.name ?? '';
	this.databasePathInput.value = state.databasePath ?? ':memory:';

	this.hostInput.value = state.host ?? 'localhost';
	this.portInput.value = state.port ? String(state.port) : '5432';
	this.databaseInput.value = state.database ?? 'postgres';
	this.usernameInput.value = state.username ?? '';
	this.passwordInput.value = state.password ?? '';
	this.sslModeInput.value = state.sslMode ?? SqlSslMode.Prefer;

	this.readOnlyInput.checked = state.readOnly;
	this.createIfMissingInput.checked = state.createIfMissing;
	this.saveConnectionInput.checked = state.saveConnection;
	this.autoConnectInput.checked = state.autoConnect;
}

private refreshDriverPreview(): void {
	const formState = this.getFormState();
	const preview = createSqlConnectionFormPreview(formState);
	const isSqlite = preview.kind === SqlConnectionKind.Sqlite;

	this.sqliteFieldsElement.classList.toggle('hidden', !isSqlite);
	this.postgresPreviewElement.classList.toggle('hidden', isSqlite);

	this.readOnlyInput.disabled = !isSqlite;
	this.createIfMissingInput.disabled = !isSqlite;
	this.saveConnectionInput.disabled = !isSqlite;
	this.autoConnectInput.disabled = !isSqlite || !this.saveConnectionInput.checked;

	if (!isSqlite) {
		this.saveConnectionInput.checked = false;
		this.autoConnectInput.checked = false;
	}

	this.connectButton.disabled = !preview.canConnect;

	clearNode(this.driverPreviewElement);

	const title = append(this.driverPreviewElement, $('.sql-connection-driver-preview-title'));
	title.textContent = preview.summary;

	const message = append(this.driverPreviewElement, $('.sql-connection-driver-preview-message'));
	message.textContent = preview.message;

	if (!isSqlite) {
		const note = append(this.driverPreviewElement, $('.sql-connection-driver-preview-note'));
		note.textContent = 'Password is accepted for preview masking only and will not be stored. Runtime PostgreSQL connection is not enabled in this phase.';
	}
}
```

---

# 3. CSS 追加

路径：

```txt id="4ptebo"
src/vs/workbench/contrib/sqlConnections/browser/media/sqlConnections.css
```

追加：

```css id="j1g17y"
.sql-connections-driver-fields {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.sql-connections-driver-fields.hidden {
	display: none;
}

.sql-connection-driver-preview {
	box-sizing: border-box;
	margin-top: 8px;
	padding: 8px;
	border: 1px solid var(--vscode-editorGroup-border);
	background: var(--vscode-sideBarSectionHeader-background);
	color: var(--vscode-descriptionForeground);
	font-size: 12px;
}

.sql-connection-driver-preview-title {
	color: var(--vscode-foreground);
	font-weight: 600;
	margin-bottom: 4px;
}

.sql-connection-driver-preview-message {
	margin-bottom: 4px;
}

.sql-connection-driver-preview-note {
	color: var(--vscode-descriptionForeground);
	font-size: 11px;
	line-height: 1.4;
}
```

---

# 4. 新增单元测试

路径：

```txt id="3qjdp7"
src/vs/workbench/contrib/sqlConnections/test/sqlConnectionFormModel.test.ts
```

```ts id="4oo2oa"
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	canSaveSqlConnectionForm,
	canSubmitSqlConnectionForm,
	createDefaultSqlConnectionFormState,
	createSqlConnectionFormPreview,
	createSqlConnectionInputFromFormState,
	getSqlConnectionFormStatus,
	maskSqlConnectionInput,
	normalizeSqlConnectionFormState,
	SQL_CONNECTION_PREVIEW_KINDS
} from '../common/sqlConnectionFormModel.js';
import { SqlDriverAvailability } from '../../../services/sql/common/sqlDrivers.js';
import {
	SqlConnectionKind,
	SqlSslMode
} from '../../../services/sql/common/sqlTypes.js';

test('SQL_CONNECTION_PREVIEW_KINDS exposes SQLite and PostgreSQL only', () => {
	assert.deepEqual(SQL_CONNECTION_PREVIEW_KINDS, [
		SqlConnectionKind.Sqlite,
		SqlConnectionKind.PostgreSql
	]);
});

test('createDefaultSqlConnectionFormState creates SQLite defaults', () => {
	assert.deepEqual(createDefaultSqlConnectionFormState(SqlConnectionKind.Sqlite), {
		kind: SqlConnectionKind.Sqlite,
		name: undefined,
		databasePath: ':memory:',
		readOnly: false,
		createIfMissing: true,
		saveConnection: false,
		autoConnect: false
	});
});

test('createDefaultSqlConnectionFormState creates PostgreSQL preview defaults', () => {
	assert.deepEqual(createDefaultSqlConnectionFormState(SqlConnectionKind.PostgreSql), {
		kind: SqlConnectionKind.PostgreSql,
		name: undefined,
		host: 'localhost',
		port: 5432,
		database: 'postgres',
		username: undefined,
		password: undefined,
		sslMode: SqlSslMode.Prefer,
		readOnly: false,
		createIfMissing: false,
		saveConnection: false,
		autoConnect: false
	});
});

test('normalizeSqlConnectionFormState normalizes SQLite fields', () => {
	const state = normalizeSqlConnectionFormState({
		kind: SqlConnectionKind.Sqlite,
		name: ' Local ',
		databasePath: ' /tmp/app.db ',
		readOnly: true,
		createIfMissing: false,
		saveConnection: true,
		autoConnect: true
	});

	assert.deepEqual(state, {
		kind: SqlConnectionKind.Sqlite,
		name: 'Local',
		databasePath: '/tmp/app.db',
		readOnly: true,
		createIfMissing: false,
		saveConnection: true,
		autoConnect: true
	});
});

test('normalizeSqlConnectionFormState disables save and autoConnect for PostgreSQL preview', () => {
	const state = normalizeSqlConnectionFormState({
		kind: SqlConnectionKind.PostgreSql,
		name: ' PG ',
		host: ' db.local ',
		port: 15432,
		database: ' app ',
		username: ' user ',
		password: ' secret ',
		sslMode: SqlSslMode.Require,
		saveConnection: true,
		autoConnect: true,
		readOnly: true,
		createIfMissing: true
	});

	assert.deepEqual(state, {
		kind: SqlConnectionKind.PostgreSql,
		name: 'PG',
		host: 'db.local',
		port: 15432,
		database: 'app',
		username: 'user',
		password: 'secret',
		sslMode: SqlSslMode.Require,
		readOnly: false,
		createIfMissing: false,
		saveConnection: false,
		autoConnect: false
	});
});

test('createSqlConnectionInputFromFormState creates SQLite input', () => {
	assert.deepEqual(
		createSqlConnectionInputFromFormState({
			kind: SqlConnectionKind.Sqlite,
			name: 'Local',
			databasePath: '/tmp/app.db',
			readOnly: true,
			createIfMissing: false
		}),
		{
			name: 'Local',
			kind: SqlConnectionKind.Sqlite,
			databasePath: '/tmp/app.db',
			readOnly: true,
			createIfMissing: false
		}
	);
});

test('createSqlConnectionInputFromFormState creates PostgreSQL preview input', () => {
	assert.deepEqual(
		createSqlConnectionInputFromFormState({
			kind: SqlConnectionKind.PostgreSql,
			name: 'App PG',
			host: 'localhost',
			port: 5432,
			database: 'app',
			username: 'user',
			password: 'secret',
			sslMode: SqlSslMode.Require
		}),
		{
			name: 'App PG',
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			port: 5432,
			database: 'app',
			username: 'user',
			password: 'secret',
			sslMode: SqlSslMode.Require,
			readOnly: false,
			createIfMissing: false
		}
	);
});

test('maskSqlConnectionInput removes password', () => {
	assert.deepEqual(
		maskSqlConnectionInput({
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			port: 5432,
			database: 'app',
			username: 'user',
			password: 'secret',
			sslMode: SqlSslMode.Prefer
		}),
		{
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			port: 5432,
			database: 'app',
			username: 'user',
			sslMode: SqlSslMode.Prefer
		}
	);
});

test('createSqlConnectionFormPreview allows SQLite connect', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.Sqlite,
		databasePath: '/tmp/app.db'
	});

	assert.equal(preview.label, 'SQLite');
	assert.equal(preview.availability, SqlDriverAvailability.Enabled);
	assert.equal(preview.canConnect, true);
	assert.equal(preview.summary, 'SQLite · /tmp/app.db');
});

test('createSqlConnectionFormPreview prevents saving memory SQLite connection', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.Sqlite,
		databasePath: ':memory:',
		saveConnection: true
	});

	assert.equal(preview.canConnect, true);
	assert.equal(preview.canSave, false);
});

test('createSqlConnectionFormPreview blocks PostgreSQL connect', () => {
	const preview = createSqlConnectionFormPreview({
		kind: SqlConnectionKind.PostgreSql,
		host: 'localhost',
		port: 5432,
		database: 'app',
		username: 'user',
		password: 'secret'
	});

	assert.equal(preview.label, 'PostgreSQL');
	assert.equal(preview.availability, SqlDriverAvailability.Planned);
	assert.equal(preview.canConnect, false);
	assert.equal(preview.canSave, false);
	assert.equal(preview.maskedInput.password, undefined);
	assert.match(preview.message, /preview-only/);
});

test('canSubmitSqlConnectionForm returns false for PostgreSQL preview', () => {
	assert.equal(
		canSubmitSqlConnectionForm({
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			database: 'app'
		}),
		false
	);
});

test('canSaveSqlConnectionForm returns true only for persistable SQLite', () => {
	assert.equal(
		canSaveSqlConnectionForm({
			kind: SqlConnectionKind.Sqlite,
			databasePath: '/tmp/app.db',
			saveConnection: true
		}),
		true
	);

	assert.equal(
		canSaveSqlConnectionForm({
			kind: SqlConnectionKind.Sqlite,
			databasePath: ':memory:',
			saveConnection: true
		}),
		false
	);
});

test('getSqlConnectionFormStatus returns preview status', () => {
	assert.equal(
		getSqlConnectionFormStatus({
			kind: SqlConnectionKind.PostgreSql,
			host: 'localhost',
			port: 5432,
			database: 'app'
		}),
		'PostgreSQL Preview · localhost:5432/app · PostgreSQL is preview-only in Phase 9.1. Runtime connection is not enabled yet.'
	);
});
```

---

# 5. 修改 `package.json`

把 `test:sql-connections` 追加新测试文件。

当前脚本应该类似：

```json id="pqkiu5"
{
  "test:sql-connections": "node --test --import tsx src/vs/workbench/contrib/sqlConnections/test/sqlConnectionTreeModel.test.ts src/vs/workbench/contrib/sqlConnections/test/sqlConnectionQueryModel.test.ts src/vs/workbench/contrib/sqlConnections/test/sqlConnectionTemplateModel.test.ts"
}
```

改成：

```json id="dzwet9"
{
  "test:sql-connections": "node --test --import tsx src/vs/workbench/contrib/sqlConnections/test/sqlConnectionTreeModel.test.ts src/vs/workbench/contrib/sqlConnections/test/sqlConnectionQueryModel.test.ts src/vs/workbench/contrib/sqlConnections/test/sqlConnectionTemplateModel.test.ts src/vs/workbench/contrib/sqlConnections/test/sqlConnectionFormModel.test.ts"
}
```

---

# 6. 验收命令

```bash id="drazch"
pnpm run test:sql-connections
pnpm run test:sql-domain
pnpm run test:sql-services
pnpm run test
pnpm run lint
pnpm run build

cd src-tauri
cargo test sql
cargo check
```

---

# 7. 手动验收

```txt id="7tdmyc"
1. 启动应用
2. SQL Connections 里 Driver 默认是 SQLite
3. SQLite 表单仍然显示 Database path / Read-only / Create if missing
4. SQLite :memory: 仍然可以 Connect
5. 切换 Driver 到 PostgreSQL Preview
6. 表单显示 Host / Port / Database / Username / Password / SSL mode
7. Connect 按钮置灰
8. Save / Auto connect 置灰
9. Preview 区域显示 PostgreSQL Preview · localhost:5432/postgres
10. Password 不在 masked preview 中出现
11. 切回 SQLite 后原 SQLite 流程正常
12. Tauri 没有真实 PostgreSQL 连接调用
```

---

# 8. Phase 9.1 完成标准

```txt id="u8bkro"
Driver-aware connection form 已建立
SQLite 连接流程不受影响
PostgreSQL Preview UI 可见
PostgreSQL Connect/Save 明确禁止
PostgreSQL input 可建模但 password 被 mask
测试覆盖 form model / preview gating / masking
不引入 PostgreSQL runtime dependency
```

---

# 9. 后续 Phase 9.2

```txt id="eb8kyr"
Phase 9.2：Secret Placeholder & Saved Profile Split

1. 保存连接 profile 时明确分离 public profile / secret reference
2. SQLite 没有 secret
3. PostgreSQL Preview 只生成 secret placeholder，不落盘 password
4. 引入 SecretStore 接口，但先用 no-op/mock
5. 仍不实现 PostgreSQL runtime connect
```

这一步做完后，再考虑 Phase 9.3 真实 PostgreSQL runtime driver。
