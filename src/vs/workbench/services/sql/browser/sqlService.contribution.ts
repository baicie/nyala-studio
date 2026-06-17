/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL service registrations.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISqlConnectionService } from '../common/sqlConnection.js';
import { ISqlMetadataService } from '../common/sqlMetadata.js';
import { ISqlQueryService } from '../common/sqlQuery.js';
import { SqlConnectionService } from './sqlConnectionService.js';
import { SqlMetadataService } from './sqlMetadataService.js';
import { SqlQueryService } from './sqlQueryService.js';

registerSingleton(ISqlConnectionService, SqlConnectionService, InstantiationType.Delayed);
registerSingleton(ISqlMetadataService, SqlMetadataService, InstantiationType.Delayed);
registerSingleton(ISqlQueryService, SqlQueryService, InstantiationType.Delayed);
