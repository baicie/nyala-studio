/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - plugin contribution bridge.
 *
 * Phase 07 splits the registry (storage + validation) from the bridge
 * (Workbench-side wiring). The bridge turns a registered plugin set into
 * contribution descriptors that are safe to hand to:
 *
 * - command registry (id / title / category / pluginId)
 * - SQL editor / context menu (id / title / command / when / pluginId /
 *   capabilities)
 *
 * Capabilities are surfaced here so a future Phase can apply policy
 * without re-walking every manifest. Commands do not need capabilities
 * (they are pure UI wiring) but sqlActions do — they execute work on
 * behalf of the plugin, so the bridge stamps the action with the
 * declaring plugin's declared capabilities.
 *
 * The bridge is intentionally pure: no DI, no I/O, no DOM. Tests can
 * exercise it directly against a registry populated with built-in or
 * in-memory plugins.
 *--------------------------------------------------------------------------------------------*/

import {
	SqlStudioPluginCapability,
	SqlStudioPluginRegistry
} from './sqlAdvancedPluginApi.js';

export interface SqlWorkbenchCommandContribution {
	readonly id: string;
	readonly title: string;
	readonly category?: string;
	readonly pluginId: string;
}

export interface SqlWorkbenchSqlActionContribution {
	readonly id: string;
	readonly title: string;
	readonly command: string;
	readonly when?: string;
	readonly pluginId: string;
	readonly capabilities: readonly SqlStudioPluginCapability[];
}

export interface SqlWorkbenchPluginContributions {
	readonly commands: readonly SqlWorkbenchCommandContribution[];
	readonly sqlActions: readonly SqlWorkbenchSqlActionContribution[];
}

export function buildWorkbenchPluginContributions(registry: SqlStudioPluginRegistry): SqlWorkbenchPluginContributions {
	const plugins = new Map(
		registry.listPlugins().map(plugin => [plugin.manifest.id, plugin.manifest])
	);

	return {
		commands: registry.listCommands().map(command => ({
			id: command.id,
			title: command.title,
			category: command.category,
			pluginId: command.pluginId
		})),
		sqlActions: registry.listSqlActions().map(action => ({
			id: action.id,
			title: action.title,
			command: action.command,
			when: action.when,
			pluginId: action.pluginId,
			capabilities: plugins.get(action.pluginId)?.capabilities ?? []
		}))
	};
}