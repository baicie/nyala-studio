import { Event as VSCodeEvent } from '../src/vs/base/common/event.js';
import type { ITableColumn, ITableRenderer } from '../src/vs/base/browser/ui/table/table.js';
import { IConfigurationService } from '../src/vs/platform/configuration/common/configuration.js';
import { ContextKeyService } from '../src/vs/platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../src/vs/platform/contextkey/common/contextkey.js';
import { InstantiationService } from '../src/vs/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../src/vs/platform/instantiation/common/serviceCollection.js';
import { IKeybindingService } from '../src/vs/platform/keybinding/common/keybinding.js';
import { NoMatchingKb } from '../src/vs/platform/keybinding/common/keybindingResolver.js';
import { IListService, ListService, WorkbenchTable } from '../src/vs/platform/list/browser/listService.js';
import {
	WORKBENCH_TABLE_IMPLEMENTATION_ID,
	WORKBENCH_TABLE_RUNTIME_PROOF
} from './sql-result-grid-benchmark-contract.mjs';

export { WORKBENCH_TABLE_IMPLEMENTATION_ID, WORKBENCH_TABLE_RUNTIME_PROOF };

type BenchmarkRow = readonly (string | null)[];

interface BenchmarkColumn {
	readonly id: string;
	readonly name: string;
}

interface WorkbenchTableBenchmarkOptions {
	readonly width: number;
	readonly height: number;
	readonly rowHeight: number;
	readonly headerHeight: number;
}

class BenchmarkCellRenderer implements ITableRenderer<string | null, HTMLElement> {
	readonly templateId = 'nyala.sqlResultGrid.workbenchTableCell';

	renderTemplate(container: HTMLElement): HTMLElement {
		container.classList.add('nyala-workbench-table-cell');
		container.setAttribute('role', 'gridcell');
		return container;
	}

	renderElement(value: string | null, index: number, container: HTMLElement): void {
		container.textContent = value === null ? 'NULL' : value;
		const row = container.closest<HTMLElement>('.monaco-list-row');
		row?.setAttribute('data-row-index', String(index));
		row?.setAttribute('role', 'row');
	}

	disposeTemplate(container: HTMLElement): void {
		container.textContent = '';
	}
}

function createConfigurationService(): IConfigurationService {
	return {
		onDidChangeConfiguration: VSCodeEvent.None,
		getValue(section?: string): unknown {
			switch (section) {
				case 'workbench.list.horizontalScrolling':
					return true;
				case 'workbench.list.multiSelectModifier':
					return 'ctrlCmd';
				case 'workbench.list.openMode':
					return 'doubleClick';
				case 'workbench.list.mouseWheelScrollSensitivity':
				case 'workbench.list.fastScrollSensitivity':
					return 1;
				default:
					return false;
			}
		}
	} as IConfigurationService;
}

function createKeybindingService(): IKeybindingService {
	return {
		mightProducePrintableCharacter: () => false,
		softDispatch: () => NoMatchingKb
	} as IKeybindingService;
}

export function createWorkbenchTableBenchmark(
	root: HTMLElement,
	rows: BenchmarkRow[],
	benchmarkColumns: BenchmarkColumn[],
	options: WorkbenchTableBenchmarkOptions
) {
	const configurationService = createConfigurationService();
	const contextKeyService = new ContextKeyService(configurationService);
	const listService = new ListService();
	const keybindingService = createKeybindingService();
	const services = new ServiceCollection(
		[IConfigurationService, configurationService],
		[IContextKeyService, contextKeyService],
		[IListService, listService],
		[IKeybindingService, keybindingService]
	);
	const instantiationService = new InstantiationService(services, true);
	const cellRenderer = new BenchmarkCellRenderer();
	const columns: ITableColumn<BenchmarkRow, string | null>[] = benchmarkColumns.map((column, columnIndex) => ({
		label: column.name,
		tooltip: '',
		weight: 112,
		minimumWidth: 112,
		maximumWidth: 112,
		templateId: cellRenderer.templateId,
		project: row => row[columnIndex] ?? null
	}));

	const host = document.createElement('div');
	host.className = 'nyala-workbench-table-host';
	host.style.width = `${options.width}px`;
	host.style.height = `${options.height}px`;
	root.append(host);

	const table = instantiationService.createInstance(
		WorkbenchTable<BenchmarkRow>,
		'nyala-sql-result-grid-benchmark',
		host,
		{
			headerRowHeight: options.headerHeight,
			getHeight: () => options.rowHeight
		},
		columns,
		[cellRenderer],
		{
			horizontalScrolling: true,
			multipleSelectionSupport: false,
			openOnSingleClick: false,
			setRowHeight: false,
			setRowLineHeight: false
		}
	);
	table.layout(options.height, options.width);
	table.splice(0, 0, rows);
	table.layout(options.height, options.width);

	const tableRoot = table.getHTMLElement();
	const viewport = tableRoot.querySelector<HTMLElement>('.monaco-list > .monaco-scrollable-element');
	for (const header of tableRoot.querySelectorAll<HTMLElement>('.monaco-table-th')) {
		header.setAttribute('role', 'columnheader');
	}
	tableRoot.setAttribute('role', 'grid');
	tableRoot.setAttribute('aria-label', 'SQL result benchmark');

	const exactPrototype = Object.getPrototypeOf(table) === WorkbenchTable.prototype;
	const domVerified = Boolean(
		tableRoot.classList.contains('monaco-table') &&
		viewport &&
		tableRoot.querySelector('.monaco-table-th') &&
		tableRoot.querySelector('.monaco-list-row[data-row-index]') &&
		tableRoot.querySelector('.monaco-table-td')
	);
	if (!exactPrototype || !domVerified || !viewport) {
		table.dispose();
		contextKeyService.dispose();
		listService.dispose();
		instantiationService.dispose();
		throw new Error('Real WorkbenchTable runtime proof failed.');
	}
	const canonicalScrollHeight = rows.length * options.rowHeight + options.headerHeight;
	const canonicalMaximumOffset = Math.max(0, canonicalScrollHeight - table.renderHeight);
	const toCanonicalOffset = (internalOffset: number) => {
		const internalMaximumOffset = Math.max(0, table.scrollHeight - table.renderHeight);
		return internalMaximumOffset > 0 ? (internalOffset / internalMaximumOffset) * canonicalMaximumOffset : 0;
	};
	const toInternalOffset = (canonicalOffset: number) => {
		const internalMaximumOffset = Math.max(0, table.scrollHeight - table.renderHeight);
		return canonicalMaximumOffset > 0 ? (canonicalOffset / canonicalMaximumOffset) * internalMaximumOffset : 0;
	};

	return {
		implementation: {
			id: WORKBENCH_TABLE_IMPLEMENTATION_ID,
			runtimeProof: WORKBENCH_TABLE_RUNTIME_PROOF,
			exactPrototype,
			domVerified
		},
		scroll: {
			get scrollTop() {
				return toCanonicalOffset(table.scrollTop);
			},
			set scrollTop(value: number) {
				table.scrollTop = toInternalOffset(value);
			},
			get scrollHeight() {
				return canonicalScrollHeight;
			},
			get clientHeight() {
				return table.renderHeight;
			},
			get offsetHeight() {
				return viewport.offsetHeight;
			}
		},
		viewport,
		dispose() {
			table.dispose();
			contextKeyService.dispose();
			listService.dispose();
			instantiationService.dispose();
		}
	};
}

Object.assign(globalThis, {
	__NYALA_CREATE_WORKBENCH_TABLE_BENCHMARK__: createWorkbenchTableBenchmark,
	__NYALA_WORKBENCH_TABLE_IMPLEMENTATION_ID__: WORKBENCH_TABLE_IMPLEMENTATION_ID,
	__NYALA_WORKBENCH_TABLE_RUNTIME_PROOF__: WORKBENCH_TABLE_RUNTIME_PROOF
});
globalThis.dispatchEvent(new globalThis.Event('nyala-workbench-table-benchmark-ready'));
