/*---------------------------------------------------------------------------------------------
 * Canonical SQL capability vocabulary shared by plugins and the Agent bridge.
 *
 * Rust re-parses these wire strings at the security boundary. Keep additions
 * explicit and update the Rust policy table in the same change.
 *--------------------------------------------------------------------------------------------*/

export const enum SqlCapability {
	DatabaseReadMetadata = 'database.readMetadata',
	DatabaseExecuteRead = 'database.executeRead',
	DatabaseExecuteWrite = 'database.executeWrite',
	FilesystemRead = 'filesystem.read',
	FilesystemWrite = 'filesystem.write',
	NetworkRequest = 'network.request',
	AgentTool = 'agent.tool',
	WorkspaceReadSql = 'workspace.readSql',
	DatabaseReadResultShape = 'database.readResultShape',
	DatabaseReadResultSample = 'database.readResultSample',
	DatabaseExplain = 'database.explain',
	HistoryRead = 'history.read'
}

export const SQL_CAPABILITY_VALUES: readonly SqlCapability[] = [
	SqlCapability.DatabaseReadMetadata,
	SqlCapability.DatabaseExecuteRead,
	SqlCapability.DatabaseExecuteWrite,
	SqlCapability.FilesystemRead,
	SqlCapability.FilesystemWrite,
	SqlCapability.NetworkRequest,
	SqlCapability.AgentTool,
	SqlCapability.WorkspaceReadSql,
	SqlCapability.DatabaseReadResultShape,
	SqlCapability.DatabaseReadResultSample,
	SqlCapability.DatabaseExplain,
	SqlCapability.HistoryRead
];

export function isSqlCapability(value: string): value is SqlCapability {
	return SQL_CAPABILITY_VALUES.includes(value as SqlCapability);
}
