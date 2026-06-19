/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - lightweight plugin API.
 * No remote plugin loading in Phase 10.
 *--------------------------------------------------------------------------------------------*/

export interface SqlStudioPluginManifest {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly contributes?: {
		readonly commands?: readonly SqlStudioPluginCommandContribution[];
		readonly sqlActions?: readonly SqlStudioPluginSqlActionContribution[];
	};
}

export interface SqlStudioPluginCommandContribution {
	readonly id: string;
	readonly title: string;
}

export interface SqlStudioPluginSqlActionContribution {
	readonly id: string;
	readonly title: string;
	readonly when?: string;
}

export interface SqlStudioRegisteredPlugin {
	readonly manifest: SqlStudioPluginManifest;
	readonly activated: boolean;
}

export class SqlStudioPluginRegistry {
	private readonly plugins = new Map<string, SqlStudioRegisteredPlugin>();
	private readonly commands = new Map<string, SqlStudioPluginCommandContribution>();
	private readonly sqlActions = new Map<string, SqlStudioPluginSqlActionContribution>();

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
			this.registerCommand(command);
		}

		for (const action of normalized.contributes?.sqlActions ?? []) {
			this.registerSqlAction(action);
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

	listCommands(): SqlStudioPluginCommandContribution[] {
		return [...this.commands.values()];
	}

	listSqlActions(): SqlStudioPluginSqlActionContribution[] {
		return [...this.sqlActions.values()];
	}

	private registerCommand(command: SqlStudioPluginCommandContribution): void {
		const normalized = normalizePluginCommand(command);

		if (this.commands.has(normalized.id)) {
			throw new Error(`Plugin command '${normalized.id}' is already registered`);
		}

		this.commands.set(normalized.id, normalized);
	}

	private registerSqlAction(action: SqlStudioPluginSqlActionContribution): void {
		const normalized = normalizeSqlAction(action);

		if (this.sqlActions.has(normalized.id)) {
			throw new Error(`Plugin SQL action '${normalized.id}' is already registered`);
		}

		this.sqlActions.set(normalized.id, normalized);
	}
}

export function normalizePluginManifest(manifest: SqlStudioPluginManifest): SqlStudioPluginManifest {
	return {
		id: normalizeRequiredString(manifest.id, 'plugin id'),
		name: normalizeRequiredString(manifest.name, 'plugin name'),
		version: normalizeRequiredString(manifest.version, 'plugin version'),
		contributes: {
			commands: (manifest.contributes?.commands ?? []).map(normalizePluginCommand),
			sqlActions: (manifest.contributes?.sqlActions ?? []).map(normalizeSqlAction)
		}
	};
}

function normalizePluginCommand(command: SqlStudioPluginCommandContribution): SqlStudioPluginCommandContribution {
	return {
		id: normalizeRequiredString(command.id, 'command id'),
		title: normalizeRequiredString(command.title, 'command title')
	};
}

function normalizeSqlAction(action: SqlStudioPluginSqlActionContribution): SqlStudioPluginSqlActionContribution {
	return {
		id: normalizeRequiredString(action.id, 'sql action id'),
		title: normalizeRequiredString(action.title, 'sql action title'),
		when: normalizeOptionalString(action.when)
	};
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
