/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product contribution.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	Extensions as WorkbenchExtensions,
	IWorkbenchContributionsRegistry,
	WorkbenchPhase
} from '../../../common/contributions.js';
import { SqlProductBootstrapContribution } from './sqlProductBootstrap.js';
import './sqlProductActions.js';

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution2(
	'workbench.contrib.sqlProductBootstrap',
	SqlProductBootstrapContribution,
	WorkbenchPhase.AfterRestored
);
