/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - advanced capabilities contribution.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import {
	ISqlAdvancedService,
	SqlAdvancedService
} from '../common/sqlAdvancedService.js';
import './sqlAdvancedActions.js';

registerSingleton(ISqlAdvancedService, SqlAdvancedService, InstantiationType.Delayed);
