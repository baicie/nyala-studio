// Diagnostic-only CSS candidate. Keep the published bundle unchanged and append
// the actual stylesheet so the variant hash covers the bytes under measurement.
export function appendBlockCellLayout(bundle) {
	return `${bundle}\n;(()=>{const style=document.createElement('style');style.dataset.nyalaCellLayout='block-center';style.textContent='zw-data-grid [data-slot="data-grid-cell"] { display: block; align-content: center; }';document.head.append(style);})();\n`;
}
