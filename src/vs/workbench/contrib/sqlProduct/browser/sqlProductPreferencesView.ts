/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Lightweight Preferences View.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlProductPreferences.css';

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import {
	DEFAULT_SQL_PRODUCT_PREFERENCES,
	getSqlProductPreferenceLabel,
	SQL_PRODUCT_MAX_RESULT_ROWS,
	SQL_PRODUCT_MAX_RESTORED_DRAFTS,
	SQL_PRODUCT_MIN_RESULT_ROWS,
	SQL_PRODUCT_MIN_RESTORED_DRAFTS,
	SqlProductPreferences
} from '../common/sqlProductPreferences.js';
import { ISqlProductPreferencesService } from '../common/sqlProductPreferencesService.js';

export const SQL_PRODUCT_PREFERENCES_VIEW_ID = 'sqlStudio.product.preferences';

export class SqlProductPreferencesView extends ViewPane {
	static readonly ID = SQL_PRODUCT_PREFERENCES_VIEW_ID;
	static readonly NAME = localize('sqlProductPreferencesViewName', 'Preferences');

	private readonly renderDisposables = this._register(new DisposableStore());

	private container!: HTMLElement;
	private contentElement!: HTMLElement;
	private statusElement!: HTMLElement;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ISqlProductPreferencesService private readonly preferencesService: ISqlProductPreferencesService
	) {
		super(
			options,
			keybindingService,
			contextMenuService,
			configurationService,
			contextKeyService,
			viewDescriptorService,
			instantiationService,
			openerService,
			themeService,
			hoverService
		);
	}

	protected override renderBody(container: HTMLElement): void {
		this.container = append(container, $('.sql-product-preferences-view'));
		this.contentElement = append(this.container, $('.sql-product-preferences-content'));
		this.statusElement = append(this.container, $('.sql-product-preferences-statusbar'));

		this._register(this.preferencesService.onDidChangePreferences(() => this.renderPreferences()));
		this.renderPreferences();
	}

	override focus(): void {
		this.contentElement?.focus();
		super.focus();
	}

	private renderPreferences(): void {
		this.renderDisposables.clear();
		clearNode(this.contentElement);

		const preferences = this.preferencesService.preferences;

		append(this.contentElement, $('h3.sql-product-preferences-title', undefined, 'Nyala Preferences'));

		this.renderBooleanPreference(preferences, 'restoreSqlLayoutOnStartup');
		this.renderBooleanPreference(preferences, 'openWelcomeQueryOnFirstLaunch');
		this.renderBooleanPreference(preferences, 'restoreEditorDraftsOnStartup');
		this.renderBooleanPreference(preferences, 'autoSaveEditorDrafts');

		this.renderNumberPreference(
			preferences,
			'resultMaxRows',
			SQL_PRODUCT_MIN_RESULT_ROWS,
			SQL_PRODUCT_MAX_RESULT_ROWS
		);

		this.renderNumberPreference(
			preferences,
			'maxRestoredEditorDrafts',
			SQL_PRODUCT_MIN_RESTORED_DRAFTS,
			SQL_PRODUCT_MAX_RESTORED_DRAFTS
		);

		this.renderDefaultQueryPreference(preferences);
		this.renderActions();

		this.setStatus('Preferences are stored locally.');
	}

	private renderBooleanPreference<K extends keyof Pick<
		SqlProductPreferences,
		'restoreSqlLayoutOnStartup' | 'openWelcomeQueryOnFirstLaunch' | 'restoreEditorDraftsOnStartup' | 'autoSaveEditorDrafts'
	>>(preferences: SqlProductPreferences, key: K): void {
		const row = append(this.contentElement, $('.sql-product-preference-row'));
		const label = append(row, $('label.sql-product-preference-checkbox'));

		const input = append(label, $('input', { type: 'checkbox' })) as HTMLInputElement;
		input.checked = preferences[key];

		append(label, $('span', undefined, getSqlProductPreferenceLabel(key)));

		this.renderDisposables.add(
			addDisposableListener(input, EventType.CHANGE, () => {
				this.preferencesService.updatePreference(key, input.checked as SqlProductPreferences[K]);
				this.setStatus(`Updated ${getSqlProductPreferenceLabel(key)}.`);
			})
		);
	}

	private renderNumberPreference<K extends keyof Pick<
		SqlProductPreferences,
		'resultMaxRows' | 'maxRestoredEditorDrafts'
	>>(
		preferences: SqlProductPreferences,
		key: K,
		min: number,
		max: number
	): void {
		const row = append(this.contentElement, $('.sql-product-preference-row'));
		const label = append(row, $('label.sql-product-preference-field'));

		append(label, $('span', undefined, getSqlProductPreferenceLabel(key)));

		const input = append(label, $('input.sql-product-preference-input', {
			type: 'number',
			min: String(min),
			max: String(max),
			value: String(preferences[key])
		})) as HTMLInputElement;

		this.renderDisposables.add(
			addDisposableListener(input, EventType.CHANGE, () => {
				this.preferencesService.updatePreference(key, Number(input.value) as SqlProductPreferences[K]);
				this.setStatus(`Updated ${getSqlProductPreferenceLabel(key)}.`);
			})
		);
	}

	private renderDefaultQueryPreference(preferences: SqlProductPreferences): void {
		const row = append(this.contentElement, $('.sql-product-preference-row'));
		const label = append(row, $('label.sql-product-preference-field'));

		append(label, $('span', undefined, getSqlProductPreferenceLabel('defaultQuery')));

		const textarea = append(label, $('textarea.sql-product-preference-textarea')) as HTMLTextAreaElement;
		textarea.value = preferences.defaultQuery;

		this.renderDisposables.add(
			addDisposableListener(textarea, EventType.CHANGE, () => {
				this.preferencesService.updatePreference('defaultQuery', textarea.value);
				this.setStatus('Updated default query.');
			})
		);
	}

	private renderActions(): void {
		const row = append(this.contentElement, $('.sql-product-preferences-actions'));

		const resetButton = append(row, $('button.sql-product-preferences-button', { type: 'button' }, 'Reset')) as HTMLButtonElement;

		const defaultsButton = append(row, $('button.sql-product-preferences-button', { type: 'button' }, 'Fill Defaults')) as HTMLButtonElement;

		this.renderDisposables.add(
			addDisposableListener(resetButton, EventType.CLICK, () => {
				this.preferencesService.reset();
				this.setStatus('Preferences reset.');
			})
		);

		this.renderDisposables.add(
			addDisposableListener(defaultsButton, EventType.CLICK, () => {
				this.preferencesService.updatePreferences(DEFAULT_SQL_PRODUCT_PREFERENCES);
				this.setStatus('Default preferences restored.');
			})
		);
	}

	private setStatus(message: string): void {
		this.statusElement.textContent = message;
	}
}
