/*---------------------------------------------------------------------------------------------
 * SQL Workspace Agent panel.
 *--------------------------------------------------------------------------------------------*/

import './media/sqlAgent.css';

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import {
	ISqlAgentService,
	SqlAgentMode,
	SqlAgentTaskKind,
	SqlAgentRunEvent
} from '../../../services/sql/common/sqlAgent.js';
import { SqlCapability } from '../../../services/sql/common/sqlCapabilities.js';
import { getDialectForConnectionKind, SqlDialect } from '../../../services/sql/common/sqlDialect.js';
import { SqlEditorPane } from '../../sqlEditor/browser/sqlEditorPane.js';
import { getSqlAgentPanelStatus, projectSqlAgentRunEvent } from '../common/sqlAgentPanelModel.js';

export const SQL_AGENT_VIEW_ID = 'nyala.sqlAgent.view';
export const SQL_AGENT_VIEWLET_ID = 'nyala.sqlAgent.panel';

export class SqlAgentView extends ViewPane {
	static readonly ID = SQL_AGENT_VIEW_ID;
	static readonly NAME = localize('sqlAgentViewName', 'SQL Agent');

	private promptElement!: HTMLTextAreaElement;
	private modeElement!: HTMLSelectElement;
	private taskElement!: HTMLSelectElement;
	private startButton!: HTMLButtonElement;
	private cancelButton!: HTMLButtonElement;
	private statusElement!: HTMLElement;
	private answerElement!: HTMLElement;
	private evidenceElement!: HTMLOListElement;
	private activityElement!: HTMLOListElement;
	private warningsElement!: HTMLOListElement;
	private activeRunId: string | undefined;

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
		@ISqlAgentService private readonly agentService: ISqlAgentService,
		@IEditorService private readonly editorService: IEditorService,
		@INotificationService private readonly notificationService: INotificationService
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
		const view = append(container, $('.sql-agent-view'));
		this.promptElement = append(
			view,
			$('textarea.sql-agent-prompt', {
				'aria-label': 'Agent prompt',
				placeholder: 'Ask about the current SQL'
			})
		) as HTMLTextAreaElement;

		const controls = append(view, $('.sql-agent-controls'));
		this.taskElement = append(controls, this.createTaskSelect()) as HTMLSelectElement;
		this.modeElement = append(controls, this.createModeSelect()) as HTMLSelectElement;
		this.startButton = this.createButton(controls, Codicon.play, 'Start Agent', 'Start Agent run');
		this.cancelButton = this.createButton(controls, Codicon.debugStop, 'Cancel', 'Cancel Agent run');

		this.statusElement = append(view, $('.sql-agent-status', { role: 'status', 'aria-live': 'polite' }));
		this.answerElement = append(view, $('.sql-agent-answer', { role: 'article' }));
		this.evidenceElement = append(
			view,
			$('ol.sql-agent-evidence', { 'aria-label': 'Agent evidence' })
		) as HTMLOListElement;
		this.activityElement = append(
			view,
			$('ol.sql-agent-activity', { 'aria-label': 'Agent activity' })
		) as HTMLOListElement;
		this.warningsElement = append(
			view,
			$('ol.sql-agent-warnings', { 'aria-label': 'Agent warnings' })
		) as HTMLOListElement;

		this._register(
			addDisposableListener(this.startButton, EventType.CLICK, () => {
				void this.startRun();
			})
		);
		this._register(
			addDisposableListener(this.cancelButton, EventType.CLICK, () => {
				void this.cancelRun();
			})
		);
		this._register(this.agentService.onDidChangeRun(event => this.applyRunEvent(event)));
		this.renderIdle();
		const lastRunEvent = this.agentService.getLastRunEvent();
		if (lastRunEvent) {
			this.applyRunEvent(lastRunEvent);
		}
	}

	override focus(): void {
		this.promptElement?.focus();
		super.focus();
	}

	private createTaskSelect(): HTMLSelectElement {
		const select = document.createElement('select');
		select.className = 'sql-agent-task';
		select.setAttribute('aria-label', 'Agent task');
		for (const [value, label] of [
			[SqlAgentTaskKind.Assistant, 'Assistant'],
			[SqlAgentTaskKind.ExplainError, 'Explain error'],
			[SqlAgentTaskKind.GenerateQuery, 'Generate query'],
			[SqlAgentTaskKind.OptimizeQuery, 'Optimize query']
		] as const) {
			const option = document.createElement('option');
			option.value = value;
			option.textContent = label;
			select.appendChild(option);
		}
		return select;
	}

	private createModeSelect(): HTMLSelectElement {
		const select = document.createElement('select');
		select.className = 'sql-agent-mode';
		select.setAttribute('aria-label', 'Agent access mode');
		for (const [value, label] of [
			[SqlAgentMode.SuggestOnly, 'Suggest only'],
			[SqlAgentMode.ReadOnly, 'Read only']
		] as const) {
			const option = document.createElement('option');
			option.value = value;
			option.textContent = label;
			select.appendChild(option);
		}
		return select;
	}

	private createButton(parent: HTMLElement, icon: ThemeIcon, label: string, title: string): HTMLButtonElement {
		const button = append(
			parent,
			$(`button.sql-agent-${label === 'Cancel' ? 'cancel' : 'start'}`, {
				type: 'button',
				title,
				'aria-label': title
			})
		) as HTMLButtonElement;
		const iconElement = append(button, $('.codicon', { 'aria-hidden': 'true' }));
		iconElement.classList.add(...ThemeIcon.asClassNameArray(icon));
		append(button, $('span', undefined, label));
		return button;
	}

	private async startRun(): Promise<void> {
		if (this.activeRunId) {
			return;
		}
		const pane = this.editorService.activeEditorPane;
		if (!(pane instanceof SqlEditorPane)) {
			this.setStatus('Open a SQL Query editor before starting an Agent run.');
			return;
		}
		const context = pane.getAssistantContext();
		const goal = this.promptElement.value.trim() || 'Review the current SQL';
		const mode = this.modeElement.value as SqlAgentMode;
		const dialect = context.connectionKind ? getDialectForConnectionKind(context.connectionKind) : SqlDialect.Sqlite;
		if (mode === SqlAgentMode.ReadOnly && dialect !== SqlDialect.Sqlite) {
			this.setStatus('Read only Agent tools currently support SQLite connections only.');
			return;
		}
		if (mode === SqlAgentMode.ReadOnly && !context.connectionId) {
			this.setStatus('Select an explicitly read-only SQLite connection first.');
			return;
		}
		const capabilities =
			mode === SqlAgentMode.ReadOnly
				? [
						SqlCapability.DatabaseExecuteRead,
						SqlCapability.DatabaseExplain,
						SqlCapability.DatabaseReadResultShape,
						SqlCapability.DatabaseReadResultSample
					]
				: [SqlCapability.AgentTool, SqlCapability.WorkspaceReadSql];

		this.setBusy(true);
		try {
			const event = await this.agentService.start({
				goal,
				task: this.taskElement.value as SqlAgentTaskKind,
				mode,
				context: {
					dialect,
					connectionId: context.connectionId,
					sql: context.sql,
					selectedSql: context.selectedSql,
					userPrompt: goal
				},
				capabilities
			});
			this.applyRunEvent(event);
		} catch (error) {
			this.setBusy(false);
			const message = error instanceof Error ? error.message : String(error);
			this.setStatus(`Error: ${message}`);
			this.notificationService.error(message);
		}
	}

	private async cancelRun(): Promise<void> {
		if (!this.activeRunId) {
			return;
		}
		try {
			const event = await this.agentService.cancel(this.activeRunId);
			this.applyRunEvent(event);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.setStatus(`Error: ${message}`);
			this.notificationService.error(message);
		}
	}

	private applyRunEvent(event: SqlAgentRunEvent): void {
		const projection = projectSqlAgentRunEvent(event);
		this.activeRunId =
			projection.state === 'completed' || projection.state === 'failed' || projection.state === 'cancelled'
				? undefined
				: projection.runId;
		this.setBusy(Boolean(this.activeRunId));
		this.setStatus(`${getSqlAgentPanelStatus(projection)} · ${projection.usageLabel}`);
		this.answerElement.textContent = projection.answerTitle
			? `${projection.answerTitle}\n\n${projection.answerContent ?? ''}`
			: '';
		clearNode(this.evidenceElement);
		for (const reference of projection.evidenceRefs) {
			append(this.evidenceElement, $('li', undefined, reference));
		}
		clearNode(this.activityElement);
		for (const call of projection.toolCalls) {
			const context = call.contextRefs.length > 0 ? ` (${call.contextRefs.join(', ')})` : '';
			append(this.activityElement, $('li', undefined, `${call.tool} · ${call.callId}${context}`));
		}
		clearNode(this.warningsElement);
		for (const warning of projection.warnings) {
			append(this.warningsElement, $('li', undefined, warning));
		}
	}

	private renderIdle(): void {
		this.setBusy(false);
		this.setStatus('Ready.');
		this.answerElement.textContent = '';
		clearNode(this.evidenceElement);
		clearNode(this.activityElement);
		clearNode(this.warningsElement);
	}

	private setBusy(busy: boolean): void {
		this.startButton.disabled = busy;
		this.cancelButton.disabled = !busy;
		this.promptElement.disabled = busy;
		this.modeElement.disabled = busy;
		this.taskElement.disabled = busy;
	}

	private setStatus(status: string): void {
		this.statusElement.textContent = status;
	}
}
