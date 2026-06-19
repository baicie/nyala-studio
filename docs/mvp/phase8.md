下面给出 **Phase 8：产品收口 / Workbench 裁剪** 的详细设计与完整代码。

先说明边界：当前 `workbench.common.main.ts` 仍然导入了 Explorer、Search、SCM、Debug、Extensions、Output 等大量 VS Code/SideX 工作台模块；SQL Studio 自身的入口集中在 `sqlConnections / sqlEditor / sqlResult` 三个 contribution。
所以 Phase 8 不建议直接物理删除 Workbench 模块，否则容易牵扯菜单、命令、服务、布局初始化。Phase 8 先做 **安全产品化收口**：产品 Profile、启动布局、SQL Home 命令、裁剪清单测试；Phase 8.5 再做物理 import 裁剪。

---

# Phase 8：产品收口 / Workbench 裁剪

## 目标

```txt id="uv13rh"
1. 固定 SQL Studio MVP 产品入口
2. 启动后默认聚焦 SQL Connections
3. 默认打开 SQL Results Panel
4. 提供 SQL Studio Home 命令
5. 提供 New SQL Query 命令入口
6. 建立 Workbench 裁剪清单
7. 用单元测试防止后续重新暴露非 SQL 主入口
```

## 不做

```txt id="azjrfg"
1. 不物理删除 Explorer/Search/SCM/Debug/Extensions 模块
2. 不改 VS Code 核心 layout service
3. 不改 activity bar 底层实现
4. 不做插件系统
5. 不做 AI
6. 不做多数据库
```

---

# 文件变化

新增：

```txt id="s4sc7d"
src/vs/workbench/contrib/sqlProduct/common/sqlProduct.ts
src/vs/workbench/contrib/sqlProduct/common/sqlProductProfile.ts
src/vs/workbench/contrib/sqlProduct/common/sqlProductBootstrapModel.ts
src/vs/workbench/contrib/sqlProduct/browser/sqlProductBootstrap.ts
src/vs/workbench/contrib/sqlProduct/browser/sqlProductActions.ts
src/vs/workbench/contrib/sqlProduct/browser/sqlProduct.contribution.ts
src/vs/workbench/contrib/sqlProduct/test/sqlProductProfile.test.ts
src/vs/workbench/contrib/sqlProduct/test/sqlProductBootstrapModel.test.ts
```

修改：

```txt id="9z046i"
src/vs/workbench/workbench.common.main.ts
package.json
```

---

# 1. 新增 `sqlProduct.ts`

路径：

```txt id="p13mqr"
src/vs/workbench/contrib/sqlProduct/common/sqlProduct.ts
```

```ts id="q8muml"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product constants.
 *--------------------------------------------------------------------------------------------*/

export const SQL_PRODUCT_NAME = 'SQL Studio Next';
export const SQL_PRODUCT_STORAGE_PREFIX = 'workbench.sqlStudio.product';

export const SQL_PRODUCT_BOOTSTRAPPED_STORAGE_KEY = `${SQL_PRODUCT_STORAGE_PREFIX}.bootstrapped`;

export const SQL_PRODUCT_HOME_COMMAND_ID = 'sqlStudio.product.home';
export const SQL_PRODUCT_NEW_QUERY_COMMAND_ID = 'sqlStudio.product.newQuery';
export const SQL_PRODUCT_OPEN_RESULTS_COMMAND_ID = 'sqlStudio.product.openResults';

export const SQL_PRODUCT_DEFAULT_QUERY = `-- SQL Studio Next
-- Start typing your SQL here.

SELECT 1 AS value;
`;
```

---

# 2. 新增 `sqlProductProfile.ts`

路径：

```txt id="x7b20l"
src/vs/workbench/contrib/sqlProduct/common/sqlProductProfile.ts
```

```ts id="589wo8"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product profile and workbench trim list.
 *--------------------------------------------------------------------------------------------*/

import { SQL_CONNECTIONS_VIEWLET_ID, SQL_CONNECTIONS_VIEW_ID } from '../../sqlConnections/common/sqlConnections.js';
import { SQL_RESULT_VIEWLET_ID, SQL_RESULT_VIEW_ID } from '../../sqlResult/common/sqlResult.js';
import { SQL_QUERY_HISTORY_VIEW_ID } from '../../sqlHistory/common/sqlQueryHistory.js';

export const enum SqlProductWorkbenchSurfaceKind {
	ViewContainer = 'viewContainer',
	View = 'view',
	Command = 'command'
}

export interface SqlProductWorkbenchSurface {
	readonly id: string;
	readonly kind: SqlProductWorkbenchSurfaceKind;
	readonly label: string;
	readonly required: boolean;
}

export const SQL_PRODUCT_REQUIRED_SURFACES: readonly SqlProductWorkbenchSurface[] = [
	{
		id: SQL_CONNECTIONS_VIEWLET_ID,
		kind: SqlProductWorkbenchSurfaceKind.ViewContainer,
		label: 'SQL Connections Container',
		required: true
	},
	{
		id: SQL_CONNECTIONS_VIEW_ID,
		kind: SqlProductWorkbenchSurfaceKind.View,
		label: 'SQL Connections View',
		required: true
	},
	{
		id: SQL_RESULT_VIEWLET_ID,
		kind: SqlProductWorkbenchSurfaceKind.ViewContainer,
		label: 'SQL Results Container',
		required: true
	},
	{
		id: SQL_RESULT_VIEW_ID,
		kind: SqlProductWorkbenchSurfaceKind.View,
		label: 'SQL Results View',
		required: true
	},
	{
		id: SQL_QUERY_HISTORY_VIEW_ID,
		kind: SqlProductWorkbenchSurfaceKind.View,
		label: 'Query History View',
		required: true
	}
];

export const SQL_PRODUCT_LEGACY_WORKBENCH_VIEWLETS: readonly string[] = [
	'workbench.view.explorer',
	'workbench.view.search',
	'workbench.view.scm',
	'workbench.view.debug',
	'workbench.view.extensions',
	'workbench.view.remote',
	'workbench.panel.terminal',
	'workbench.panel.output',
	'workbench.panel.markers',
	'workbench.panel.comments'
];

export interface SqlProductProfile {
	readonly name: string;
	readonly primaryViewContainers: readonly string[];
	readonly requiredSurfaces: readonly SqlProductWorkbenchSurface[];
	readonly legacyWorkbenchViewlets: readonly string[];
}

export const SQL_STUDIO_PRODUCT_PROFILE: SqlProductProfile = {
	name: 'SQL Studio Next',
	primaryViewContainers: [
		SQL_CONNECTIONS_VIEWLET_ID,
		SQL_RESULT_VIEWLET_ID
	],
	requiredSurfaces: SQL_PRODUCT_REQUIRED_SURFACES,
	legacyWorkbenchViewlets: SQL_PRODUCT_LEGACY_WORKBENCH_VIEWLETS
};

export function isSqlProductPrimaryViewContainer(id: string): boolean {
	return SQL_STUDIO_PRODUCT_PROFILE.primaryViewContainers.includes(id);
}

export function isLegacyWorkbenchViewlet(id: string): boolean {
	return SQL_STUDIO_PRODUCT_PROFILE.legacyWorkbenchViewlets.includes(id);
}

export function assertNoLegacyWorkbenchSurface(ids: readonly string[]): void {
	const legacy = ids.filter(isLegacyWorkbenchViewlet);

	if (legacy.length > 0) {
		throw new Error(`Legacy workbench surface should not be exposed in SQL Studio MVP: ${legacy.join(', ')}`);
	}
}

export function getSqlProductRequiredSurfaceIds(): string[] {
	return SQL_STUDIO_PRODUCT_PROFILE.requiredSurfaces.map(surface => surface.id);
}

export function getSqlProductTrimReport(ids: readonly string[]): {
	readonly allowed: string[];
	readonly legacy: string[];
	readonly unknown: string[];
} {
	const required = new Set(getSqlProductRequiredSurfaceIds());
	const legacy = new Set(SQL_STUDIO_PRODUCT_PROFILE.legacyWorkbenchViewlets);

	const allowedIds: string[] = [];
	const legacyIds: string[] = [];
	const unknownIds: string[] = [];

	for (const id of ids) {
		if (required.has(id)) {
			allowedIds.push(id);
			continue;
		}

		if (legacy.has(id)) {
			legacyIds.push(id);
			continue;
		}

		unknownIds.push(id);
	}

	return {
		allowed: allowedIds,
		legacy: legacyIds,
		unknown: unknownIds
	};
}
```

---

# 3. 新增 `sqlProductBootstrapModel.ts`

路径：

```txt id="3nhjhu"
src/vs/workbench/contrib/sqlProduct/common/sqlProductBootstrapModel.ts
```

```ts id="y7ck0r"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product bootstrap pure model.
 *--------------------------------------------------------------------------------------------*/

import { SQL_CONNECTIONS_FOCUS_COMMAND_ID } from '../../sqlConnections/common/sqlConnections.js';
import { SQL_RESULT_OPEN_COMMAND_ID } from '../../sqlResult/common/sqlResult.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import { SQL_PRODUCT_DEFAULT_QUERY } from './sqlProduct.js';

export const enum SqlProductStartupCommandKind {
	FocusConnections = 'focusConnections',
	OpenResults = 'openResults',
	NewQuery = 'newQuery'
}

export interface SqlProductStartupCommand {
	readonly kind: SqlProductStartupCommandKind;
	readonly commandId: string;
	readonly args?: unknown[];
}

export interface SqlProductBootstrapOptions {
	readonly alreadyBootstrapped: boolean;
	readonly restoreSqlLayout?: boolean;
	readonly openWelcomeQuery?: boolean;
	readonly force?: boolean;
}

export function shouldRunSqlProductBootstrap(options: SqlProductBootstrapOptions): boolean {
	if (options.force) {
		return true;
	}

	return !options.alreadyBootstrapped;
}

export function createSqlProductStartupPlan(options: SqlProductBootstrapOptions): SqlProductStartupCommand[] {
	if (!shouldRunSqlProductBootstrap(options)) {
		return [];
	}

	const restoreSqlLayout = options.restoreSqlLayout !== false;
	const openWelcomeQuery = options.openWelcomeQuery === true;

	const commands: SqlProductStartupCommand[] = [];

	if (restoreSqlLayout) {
		commands.push({
			kind: SqlProductStartupCommandKind.FocusConnections,
			commandId: SQL_CONNECTIONS_FOCUS_COMMAND_ID
		});

		commands.push({
			kind: SqlProductStartupCommandKind.OpenResults,
			commandId: SQL_RESULT_OPEN_COMMAND_ID
		});
	}

	if (openWelcomeQuery) {
		commands.push({
			kind: SqlProductStartupCommandKind.NewQuery,
			commandId: SQL_NEW_QUERY_COMMAND_ID,
			args: [
				{
					initialSql: SQL_PRODUCT_DEFAULT_QUERY
				}
			]
		});
	}

	return dedupeStartupCommands(commands);
}

export function dedupeStartupCommands(commands: readonly SqlProductStartupCommand[]): SqlProductStartupCommand[] {
	const seen = new Set<string>();
	const result: SqlProductStartupCommand[] = [];

	for (const command of commands) {
		const key = `${command.commandId}:${JSON.stringify(command.args ?? [])}`;

		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		result.push(command);
	}

	return result;
}
```

---

# 4. 新增 `sqlProductBootstrap.ts`

路径：

```txt id="vzovgi"
src/vs/workbench/contrib/sqlProduct/browser/sqlProductBootstrap.ts
```

```ts id="1nn68y"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product bootstrap contribution.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import {
	IStorageService,
	StorageScope,
	StorageTarget
} from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import {
	createSqlProductStartupPlan,
	SqlProductStartupCommand
} from '../common/sqlProductBootstrapModel.js';
import {
	SQL_PRODUCT_BOOTSTRAPPED_STORAGE_KEY,
	SQL_PRODUCT_NAME
} from '../common/sqlProduct.js';

export class SqlProductBootstrapContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService
	) {
		super();

		this.bootstrap().catch(error => {
			const message = error instanceof Error ? error.message : String(error);
			this.notificationService.warn(`${SQL_PRODUCT_NAME} startup layout was not fully restored: ${message}`);
		});
	}

	private async bootstrap(): Promise<void> {
		const alreadyBootstrapped = this.storageService.getBoolean(
			SQL_PRODUCT_BOOTSTRAPPED_STORAGE_KEY,
			StorageScope.PROFILE,
			false
		) === true;

		const plan = createSqlProductStartupPlan({
			alreadyBootstrapped,
			restoreSqlLayout: true,
			openWelcomeQuery: false
		});

		await this.runPlan(plan);

		if (!alreadyBootstrapped) {
			this.storageService.store(
				SQL_PRODUCT_BOOTSTRAPPED_STORAGE_KEY,
				true,
				StorageScope.PROFILE,
				StorageTarget.USER
			);
		}
	}

	private async runPlan(plan: readonly SqlProductStartupCommand[]): Promise<void> {
		for (const item of plan) {
			await this.commandService.executeCommand(item.commandId, ...(item.args ?? []));
		}
	}
}
```

---

# 5. 新增 `sqlProductActions.ts`

路径：

```txt id="pc724c"
src/vs/workbench/contrib/sqlProduct/browser/sqlProductActions.ts
```

```ts id="4i686g"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product commands.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { SQL_CONNECTIONS_FOCUS_COMMAND_ID } from '../../sqlConnections/common/sqlConnections.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import { SQL_RESULT_OPEN_COMMAND_ID } from '../../sqlResult/common/sqlResult.js';
import {
	SQL_PRODUCT_DEFAULT_QUERY,
	SQL_PRODUCT_HOME_COMMAND_ID,
	SQL_PRODUCT_NEW_QUERY_COMMAND_ID,
	SQL_PRODUCT_OPEN_RESULTS_COMMAND_ID
} from '../common/sqlProduct.js';

class SqlProductHomeAction extends Action2 {
	constructor() {
		super({
			id: SQL_PRODUCT_HOME_COMMAND_ID,
			title: localize2('sqlProductHome', 'SQL Studio: Home'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);

		await commandService.executeCommand(SQL_CONNECTIONS_FOCUS_COMMAND_ID);
		await commandService.executeCommand(SQL_RESULT_OPEN_COMMAND_ID);
	}
}

class SqlProductNewQueryAction extends Action2 {
	constructor() {
		super({
			id: SQL_PRODUCT_NEW_QUERY_COMMAND_ID,
			title: localize2('sqlProductNewQuery', 'SQL Studio: New Query'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);

		await commandService.executeCommand(SQL_NEW_QUERY_COMMAND_ID, {
			initialSql: SQL_PRODUCT_DEFAULT_QUERY
		});
	}
}

class SqlProductOpenResultsAction extends Action2 {
	constructor() {
		super({
			id: SQL_PRODUCT_OPEN_RESULTS_COMMAND_ID,
			title: localize2('sqlProductOpenResults', 'SQL Studio: Open Results'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);

		await commandService.executeCommand(SQL_RESULT_OPEN_COMMAND_ID);
	}
}

registerAction2(SqlProductHomeAction);
registerAction2(SqlProductNewQueryAction);
registerAction2(SqlProductOpenResultsAction);
```

---

# 6. 新增 `sqlProduct.contribution.ts`

路径：

```txt id="s578p4"
src/vs/workbench/contrib/sqlProduct/browser/sqlProduct.contribution.ts
```

```ts id="qobc34"
/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product contribution.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	Extensions as WorkbenchExtensions,
	IWorkbenchContributionsRegistry,
	WorkbenchPhase
} from '../../../common/contributions.js';
import { SqlProductBootstrapContribution } from './sqlProductBootstrap.js';
import './sqlProductActions.js';

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution2(
	'workbench.contrib.sqlProductBootstrap',
	SqlProductBootstrapContribution,
	WorkbenchPhase.AfterRestored
);
```

---

# 7. 修改 `workbench.common.main.ts`

路径：

```txt id="7b8r3c"
src/vs/workbench/workbench.common.main.ts
```

当前 SQL Studio contribution 已经集中导入：

```ts id="m0l4pq"
import './contrib/sqlConnections/browser/sqlConnections.contribution.js';
import './contrib/sqlEditor/browser/sqlEditor.contribution.js';
import './contrib/sqlResult/browser/sqlResult.contribution.js';
```

追加一行：

```ts id="uigr6f"
import './contrib/sqlProduct/browser/sqlProduct.contribution.js';
```

最终应为：

```ts id="s6f3mw"
// SQL Studio
import './contrib/sqlConnections/browser/sqlConnections.contribution.js';
import './contrib/sqlEditor/browser/sqlEditor.contribution.js';
import './contrib/sqlResult/browser/sqlResult.contribution.js';
import './contrib/sqlProduct/browser/sqlProduct.contribution.js';
```

---

# 8. 新增 `sqlProductProfile.test.ts`

路径：

```txt id="08par0"
src/vs/workbench/contrib/sqlProduct/test/sqlProductProfile.test.ts
```

```ts id="4ggjhy"
import assert from 'node:assert/strict';
import test from 'node:test';

import { SQL_CONNECTIONS_VIEW_ID, SQL_CONNECTIONS_VIEWLET_ID } from '../../sqlConnections/common/sqlConnections.js';
import { SQL_RESULT_VIEW_ID, SQL_RESULT_VIEWLET_ID } from '../../sqlResult/common/sqlResult.js';
import { SQL_QUERY_HISTORY_VIEW_ID } from '../../sqlHistory/common/sqlQueryHistory.js';
import {
	assertNoLegacyWorkbenchSurface,
	getSqlProductRequiredSurfaceIds,
	getSqlProductTrimReport,
	isLegacyWorkbenchViewlet,
	isSqlProductPrimaryViewContainer,
	SQL_PRODUCT_LEGACY_WORKBENCH_VIEWLETS,
	SQL_STUDIO_PRODUCT_PROFILE,
	SqlProductWorkbenchSurfaceKind
} from '../common/sqlProductProfile.js';

test('SQL_STUDIO_PRODUCT_PROFILE exposes only SQL primary view containers', () => {
	assert.deepEqual(SQL_STUDIO_PRODUCT_PROFILE.primaryViewContainers, [
		SQL_CONNECTIONS_VIEWLET_ID,
		SQL_RESULT_VIEWLET_ID
	]);

	assert.equal(isSqlProductPrimaryViewContainer(SQL_CONNECTIONS_VIEWLET_ID), true);
	assert.equal(isSqlProductPrimaryViewContainer(SQL_RESULT_VIEWLET_ID), true);
	assert.equal(isSqlProductPrimaryViewContainer('workbench.view.explorer'), false);
});

test('SQL product required surfaces include connections results and history', () => {
	assert.deepEqual(getSqlProductRequiredSurfaceIds(), [
		SQL_CONNECTIONS_VIEWLET_ID,
		SQL_CONNECTIONS_VIEW_ID,
		SQL_RESULT_VIEWLET_ID,
		SQL_RESULT_VIEW_ID,
		SQL_QUERY_HISTORY_VIEW_ID
	]);
});

test('required surfaces have stable kinds and labels', () => {
	const containerSurfaces = SQL_STUDIO_PRODUCT_PROFILE.requiredSurfaces.filter(
		surface => surface.kind === SqlProductWorkbenchSurfaceKind.ViewContainer
	);

	assert.deepEqual(
		containerSurfaces.map(surface => surface.id),
		[
			SQL_CONNECTIONS_VIEWLET_ID,
			SQL_RESULT_VIEWLET_ID
		]
	);

	for (const surface of SQL_STUDIO_PRODUCT_PROFILE.requiredSurfaces) {
		assert.equal(surface.required, true);
		assert.ok(surface.label.length > 0);
	}
});

test('legacy workbench viewlets are marked as legacy', () => {
	assert.equal(isLegacyWorkbenchViewlet('workbench.view.explorer'), true);
	assert.equal(isLegacyWorkbenchViewlet('workbench.view.search'), true);
	assert.equal(isLegacyWorkbenchViewlet('workbench.view.scm'), true);
	assert.equal(isLegacyWorkbenchViewlet('workbench.view.debug'), true);
	assert.equal(isLegacyWorkbenchViewlet('workbench.view.extensions'), true);
	assert.equal(isLegacyWorkbenchViewlet(SQL_CONNECTIONS_VIEWLET_ID), false);
});

test('assertNoLegacyWorkbenchSurface throws for legacy surface', () => {
	assert.throws(
		() => assertNoLegacyWorkbenchSurface([SQL_CONNECTIONS_VIEWLET_ID, 'workbench.view.explorer']),
		/Legacy workbench surface/
	);
});

test('assertNoLegacyWorkbenchSurface accepts SQL-only surfaces', () => {
	assert.doesNotThrow(() => {
		assertNoLegacyWorkbenchSurface([
			SQL_CONNECTIONS_VIEWLET_ID,
			SQL_RESULT_VIEWLET_ID
		]);
	});
});

test('getSqlProductTrimReport classifies ids', () => {
	const report = getSqlProductTrimReport([
		SQL_CONNECTIONS_VIEWLET_ID,
		'workbench.view.explorer',
		'custom.unknown'
	]);

	assert.deepEqual(report.allowed, [SQL_CONNECTIONS_VIEWLET_ID]);
	assert.deepEqual(report.legacy, ['workbench.view.explorer']);
	assert.deepEqual(report.unknown, ['custom.unknown']);
});

test('legacy workbench viewlet list has no duplicates', () => {
	assert.equal(
		new Set(SQL_PRODUCT_LEGACY_WORKBENCH_VIEWLETS).size,
		SQL_PRODUCT_LEGACY_WORKBENCH_VIEWLETS.length
	);
});
```

---

# 9. 新增 `sqlProductBootstrapModel.test.ts`

路径：

```txt id="s87gli"
src/vs/workbench/contrib/sqlProduct/test/sqlProductBootstrapModel.test.ts
```

```ts id="p8c2z5"
import assert from 'node:assert/strict';
import test from 'node:test';

import { SQL_CONNECTIONS_FOCUS_COMMAND_ID } from '../../sqlConnections/common/sqlConnections.js';
import { SQL_NEW_QUERY_COMMAND_ID } from '../../sqlEditor/common/sqlEditor.js';
import { SQL_RESULT_OPEN_COMMAND_ID } from '../../sqlResult/common/sqlResult.js';
import { SQL_PRODUCT_DEFAULT_QUERY } from '../common/sqlProduct.js';
import {
	createSqlProductStartupPlan,
	dedupeStartupCommands,
	shouldRunSqlProductBootstrap,
	SqlProductStartupCommandKind
} from '../common/sqlProductBootstrapModel.js';

test('shouldRunSqlProductBootstrap runs on first launch', () => {
	assert.equal(
		shouldRunSqlProductBootstrap({
			alreadyBootstrapped: false
		}),
		true
	);
});

test('shouldRunSqlProductBootstrap skips after bootstrapped', () => {
	assert.equal(
		shouldRunSqlProductBootstrap({
			alreadyBootstrapped: true
		}),
		false
	);
});

test('shouldRunSqlProductBootstrap respects force', () => {
	assert.equal(
		shouldRunSqlProductBootstrap({
			alreadyBootstrapped: true,
			force: true
		}),
		true
	);
});

test('createSqlProductStartupPlan creates SQL layout plan', () => {
	const plan = createSqlProductStartupPlan({
		alreadyBootstrapped: false
	});

	assert.deepEqual(
		plan.map(item => item.kind),
		[
			SqlProductStartupCommandKind.FocusConnections,
			SqlProductStartupCommandKind.OpenResults
		]
	);

	assert.deepEqual(
		plan.map(item => item.commandId),
		[
			SQL_CONNECTIONS_FOCUS_COMMAND_ID,
			SQL_RESULT_OPEN_COMMAND_ID
		]
	);
});

test('createSqlProductStartupPlan skips when already bootstrapped', () => {
	const plan = createSqlProductStartupPlan({
		alreadyBootstrapped: true
	});

	assert.deepEqual(plan, []);
});

test('createSqlProductStartupPlan can skip layout restore', () => {
	const plan = createSqlProductStartupPlan({
		alreadyBootstrapped: false,
		restoreSqlLayout: false
	});

	assert.deepEqual(plan, []);
});

test('createSqlProductStartupPlan can open welcome query', () => {
	const plan = createSqlProductStartupPlan({
		alreadyBootstrapped: false,
		restoreSqlLayout: false,
		openWelcomeQuery: true
	});

	assert.equal(plan.length, 1);
	assert.equal(plan[0].kind, SqlProductStartupCommandKind.NewQuery);
	assert.equal(plan[0].commandId, SQL_NEW_QUERY_COMMAND_ID);
	assert.deepEqual(plan[0].args, [
		{
			initialSql: SQL_PRODUCT_DEFAULT_QUERY
		}
	]);
});

test('dedupeStartupCommands removes duplicate command args pairs', () => {
	const plan = dedupeStartupCommands([
		{
			kind: SqlProductStartupCommandKind.FocusConnections,
			commandId: SQL_CONNECTIONS_FOCUS_COMMAND_ID
		},
		{
			kind: SqlProductStartupCommandKind.FocusConnections,
			commandId: SQL_CONNECTIONS_FOCUS_COMMAND_ID
		},
		{
			kind: SqlProductStartupCommandKind.OpenResults,
			commandId: SQL_RESULT_OPEN_COMMAND_ID
		}
	]);

	assert.deepEqual(
		plan.map(item => item.commandId),
		[
			SQL_CONNECTIONS_FOCUS_COMMAND_ID,
			SQL_RESULT_OPEN_COMMAND_ID
		]
	);
});
```

---

# 10. 修改 `package.json`

当前 test 链路已经包含 SQL services/domain/connections/editor/result/history。

新增脚本：

```json id="r80mvf"
{
  "scripts": {
    "test:sql-product": "node --test --import tsx src/vs/workbench/contrib/sqlProduct/test/sqlProductProfile.test.ts src/vs/workbench/contrib/sqlProduct/test/sqlProductBootstrapModel.test.ts"
  }
}
```

把总测试改为：

```json id="c3w6sx"
{
  "scripts": {
    "test": "pnpm run test:branding && pnpm run test:rust && pnpm run test:sql-services && pnpm run test:sql-domain && pnpm run test:sql-connections && pnpm run test:sql-editor && pnpm run test:sql-result && pnpm run test:sql-history && pnpm run test:sql-product"
  }
}
```

---

# 11. 验收命令

```bash id="c9z2ur"
pnpm run test:sql-product
pnpm run test
pnpm run lint
pnpm run build
```

---

# 12. 手动验收

```txt id="uj672y"
1. 启动应用
2. 首次启动后默认聚焦 SQL Connections
3. SQL Results Panel 默认被打开
4. Command Palette 输入 SQL Studio: Home
5. 能重新聚焦 Connections + Results
6. Command Palette 输入 SQL Studio: New Query
7. 能打开 SQL Query Editor
8. Command Palette 输入 SQL Studio: Open Results
9. 能打开 SQL Results Panel
10. 不出现新的多数据库、AI、插件入口
```

---

# 13. Phase 8 完成标准

```txt id="d4lbjx"
1. SQL Studio 产品入口固定
2. 首次启动 layout 自动收口到 SQL Connections + SQL Results
3. SQL Studio Home / New Query / Open Results 命令可用
4. Product Profile 明确列出 SQL 必需 surfaces
5. Legacy Workbench surfaces 有裁剪清单
6. 单元测试保证 SQL MVP 入口不被误改
7. 不物理删除 VS Code 模块
```

---

# 14. 后续 Phase 8.5

Phase 8.5 再处理真实物理裁剪：

```txt id="kxxwc5"
1. 逐个移除 Explorer/Search/SCM/Debug/Extensions imports
2. 观察编译缺失服务
3. 替换成 null contribution 或产品级 stub
4. 验证菜单/命令/布局无启动错误
5. 再考虑包体积下降
```

这一步必须小步做，因为当前 `workbench.common.main.ts` 还直接导入大量非 SQL contribution，贸然删除很容易触发隐式依赖缺失。
