/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - lightweight plugin API.
 *
 * Phase 07 MVP manifest schema:
 * - capabilities use the canonical SQL service vocabulary. The Rust Agent
 *   policy re-validates them before any tool can run; this registry remains a
 *   UI-side declaration and is not itself an authorization boundary.
 * - activationEvents are strings (`onSqlEditor`, etc.). They are stored as-is
 *   in MVP so contribution wiring can opt into `*` / `onCommand:foo` /
 *   `onView:bar` activation without changing this registry.
 * - Every registered command / sqlAction records its `pluginId` so the
 *   Workbench bridge can attribute contributions back to a manifest.
 * - sqlActions must reference an existing command. Missing-command detection
 *   is centralized here so the bridge layer does not need to know about it.
 * - Manifests are normalized at registration time: strings trimmed, blank
 *   values rejected, capability / activation lists deduped. That keeps the
 *   bridge output deterministic and unit-test friendly.
 *
 * No remote plugin loading. Built-in plugins register through
 * `builtinSqlPlugins.ts` only.
 *--------------------------------------------------------------------------------------------*/

import { isSqlCapability, SqlCapability } from '../../../services/sql/common/sqlCapabilities.js';

export { SqlCapability as SqlStudioPluginCapability } from '../../../services/sql/common/sqlCapabilities.js';

export interface SqlStudioPluginManifest {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly activationEvents?: readonly string[];
	readonly capabilities?: readonly SqlCapability[];
	readonly contributes?: {
		readonly commands?: readonly SqlStudioPluginCommandContribution[];
		readonly sqlActions?: readonly SqlStudioPluginSqlActionContribution[];
		readonly views?: readonly SqlStudioPluginViewContribution[];
		readonly panels?: readonly SqlStudioPluginPanelContribution[];
	};
}

export interface SqlStudioPluginCommandContribution {
	readonly id: string;
	readonly title: string;
	readonly category?: string;
}

export interface SqlStudioPluginSqlActionContribution {
	readonly id: string;
	readonly title: string;
	readonly command: string;
	readonly when?: string;
}

export interface SqlStudioPluginViewContribution {
	readonly id: string;
	readonly title: string;
	readonly when?: string;
}

export interface SqlStudioPluginPanelContribution {
	readonly id: string;
	readonly title: string;
	readonly when?: string;
}

export interface SqlStudioPluginCommandContributionWithPlugin extends SqlStudioPluginCommandContribution {
	readonly pluginId: string;
}

export interface SqlStudioPluginSqlActionContributionWithPlugin extends SqlStudioPluginSqlActionContribution {
	readonly pluginId: string;
}

export interface SqlStudioRegisteredPlugin {
	readonly manifest: SqlStudioPluginManifest;
	readonly activated: boolean;
}

export class SqlStudioPluginRegistry {
	private readonly plugins = new Map<string, SqlStudioRegisteredPlugin>();
	private readonly commands = new Map<string, SqlStudioPluginCommandContributionWithPlugin>();
	private readonly sqlActions = new Map<string, SqlStudioPluginSqlActionContributionWithPlugin>();

	registerPlugin(manifest: SqlStudioPluginManifest): SqlStudioRegisteredPlugin {
		const normalized = normalizePluginManifest(manifest);

		if (this.plugins.has(normalized.id)) {
			throw new Error(`Plugin '${normalized.id}' is already registered`);
		}

		const registered: SqlStudioRegisteredPlugin = {
			manifest: normalized,
			activated: false
		};

		this.plugins.set(normalized.id, registered);

		for (const command of normalized.contributes?.commands ?? []) {
			this.registerCommand(normalized.id, command);
		}

		for (const action of normalized.contributes?.sqlActions ?? []) {
			this.registerSqlAction(normalized.id, action);
		}

		return registered;
	}

	activatePlugin(id: string): SqlStudioRegisteredPlugin {
		const plugin = this.plugins.get(id);

		if (!plugin) {
			throw new Error(`Plugin '${id}' is not registered`);
		}

		const activated = {
			...plugin,
			activated: true
		};

		this.plugins.set(id, activated);
		return activated;
	}

	listPlugins(): SqlStudioRegisteredPlugin[] {
		return [...this.plugins.values()];
	}

	listCommands(): SqlStudioPluginCommandContributionWithPlugin[] {
		return [...this.commands.values()];
	}

	listSqlActions(): SqlStudioPluginSqlActionContributionWithPlugin[] {
		return [...this.sqlActions.values()];
	}

	private registerCommand(pluginId: string, command: SqlStudioPluginCommandContribution): void {
		const normalized = normalizePluginCommand(command);

		if (this.commands.has(normalized.id)) {
			throw new Error(`Plugin command '${normalized.id}' is already registered`);
		}

		this.commands.set(normalized.id, { ...normalized, pluginId });
	}

	private registerSqlAction(pluginId: string, action: SqlStudioPluginSqlActionContribution): void {
		const normalized = normalizeSqlAction(action);

		if (this.sqlActions.has(normalized.id)) {
			throw new Error(`Plugin SQL action '${normalized.id}' is already registered`);
		}

		if (!this.commands.has(normalized.command)) {
			throw new Error(`Plugin SQL action '${normalized.id}' references unknown command '${normalized.command}'`);
		}

		this.sqlActions.set(normalized.id, { ...normalized, pluginId });
	}
}

export function normalizePluginManifest(manifest: SqlStudioPluginManifest): SqlStudioPluginManifest {
	return {
		id: normalizeRequiredString(manifest.id, 'plugin id'),
		name: normalizeRequiredString(manifest.name, 'plugin name'),
		version: normalizeRequiredString(manifest.version, 'plugin version'),
		activationEvents: normalizeStringArray(manifest.activationEvents),
		capabilities: normalizeCapabilities(manifest.capabilities),
		contributes: {
			commands: (manifest.contributes?.commands ?? []).map(normalizePluginCommand),
			sqlActions: (manifest.contributes?.sqlActions ?? []).map(normalizeSqlAction),
			views: (manifest.contributes?.views ?? []).map(normalizeView),
			panels: (manifest.contributes?.panels ?? []).map(normalizePanel)
		}
	};
}

function normalizePluginCommand(command: SqlStudioPluginCommandContribution): SqlStudioPluginCommandContribution {
	return {
		id: normalizeRequiredString(command.id, 'command id'),
		title: normalizeRequiredString(command.title, 'command title'),
		category: normalizeOptionalString(command.category)
	};
}

function normalizeSqlAction(action: SqlStudioPluginSqlActionContribution): SqlStudioPluginSqlActionContribution {
	return {
		id: normalizeRequiredString(action.id, 'sql action id'),
		title: normalizeRequiredString(action.title, 'sql action title'),
		command: normalizeRequiredString(action.command, 'sql action command'),
		when: normalizeOptionalString(action.when)
	};
}

function normalizeView(view: SqlStudioPluginViewContribution): SqlStudioPluginViewContribution {
	return {
		id: normalizeRequiredString(view.id, 'view id'),
		title: normalizeRequiredString(view.title, 'view title'),
		when: normalizeOptionalString(view.when)
	};
}

function normalizePanel(panel: SqlStudioPluginPanelContribution): SqlStudioPluginPanelContribution {
	return {
		id: normalizeRequiredString(panel.id, 'panel id'),
		title: normalizeRequiredString(panel.title, 'panel title'),
		when: normalizeOptionalString(panel.when)
	};
}

export function normalizeCapabilities(values: readonly SqlCapability[] | undefined): SqlCapability[] {
	const normalized = [...new Set(values ?? [])];
	for (const value of normalized) {
		if (!isSqlCapability(value)) {
			throw new Error(`Unsupported SQL capability '${value}'`);
		}
	}
	return normalized;
}

export function normalizeStringArray(values: readonly string[] | undefined): string[] {
	return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))];
}

function normalizeRequiredString(value: string, field: string): string {
	const normalized = value?.trim();

	if (!normalized) {
		throw new Error(`${field} must not be empty`);
	}

	return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}
