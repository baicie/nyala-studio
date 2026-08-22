/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL Result renderer contract.
 *--------------------------------------------------------------------------------------------*/

export const SQL_RESULT_NATIVE_RENDERER_ID = 'native' as const;
export const SQL_RESULT_ZEUS_PREVIEW_RENDERER_ID = 'zeus-preview' as const;

export type SqlResultRendererId = typeof SQL_RESULT_NATIVE_RENDERER_ID | typeof SQL_RESULT_ZEUS_PREVIEW_RENDERER_ID;

export interface SqlResultRendererAvailability {
	readonly zeusPreview: boolean;
}

export interface SqlResultRendererSelection {
	readonly requested: SqlResultRendererId;
	readonly selected: SqlResultRendererId;
	readonly fallback: boolean;
	readonly reason?: string;
}

/**
 * Resolves the requested renderer without allowing an unavailable preview to
 * change the result surface. Native rendering is always the fail-closed path.
 */
export function resolveSqlResultRenderer(
	requested: unknown,
	availability: SqlResultRendererAvailability
): SqlResultRendererSelection {
	if (requested !== SQL_RESULT_NATIVE_RENDERER_ID && requested !== SQL_RESULT_ZEUS_PREVIEW_RENDERER_ID) {
		return {
			requested: SQL_RESULT_NATIVE_RENDERER_ID,
			selected: SQL_RESULT_NATIVE_RENDERER_ID,
			fallback: true,
			reason: 'Unknown result renderer preference.'
		};
	}

	if (requested === SQL_RESULT_ZEUS_PREVIEW_RENDERER_ID && availability.zeusPreview !== true) {
		return {
			requested,
			selected: SQL_RESULT_NATIVE_RENDERER_ID,
			fallback: true,
			reason: 'Zeus Preview is unavailable.'
		};
	}

	return {
		requested,
		selected: requested,
		fallback: false
	};
}
