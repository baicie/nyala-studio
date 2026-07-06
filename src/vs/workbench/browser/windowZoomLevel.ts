/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Window zoom level helpers.
 *
 * `window.zoomLevel` is the user-facing integer zoom index exposed in
 * the settings UI. Internally the workbench needs the matching zoom
 * factor (a real-number multiplier like 1.2^x) to feed Tauri's webview
 * `setZoom`. This module keeps the normalization in one place so the
 * `WindowZoomLevelContribution` and any future caller (e.g. menu
 * keyboard handlers) agree on the valid range.
 *--------------------------------------------------------------------------------------------*/

export const WINDOW_ZOOM_LEVEL_SETTING = 'window.zoomLevel';
export const WINDOW_ZOOM_LEVEL_MIN = -8;
export const WINDOW_ZOOM_LEVEL_MAX = 9;
export const WINDOW_ZOOM_LEVEL_DEFAULT = 0;

/**
 * Clamp arbitrary user input to the supported zoom-level integer range.
 *
 * Returns 0 for `NaN`, `undefined`, non-numeric values, or anything
 * outside `[-8, 9]`. The range matches VS Code's default zoom steps
 * (Ctrl/Cmd + `=` / `-` / `0` keys).
 */
export function normalizeWindowZoomLevel(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return WINDOW_ZOOM_LEVEL_DEFAULT;
	}

	return Math.min(WINDOW_ZOOM_LEVEL_MAX, Math.max(WINDOW_ZOOM_LEVEL_MIN, Math.trunc(value)));
}