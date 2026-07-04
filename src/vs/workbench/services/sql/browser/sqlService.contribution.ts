/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL service registrations.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISqlAiService } from '../common/sqlAi.js';
import { ISqlConnectionService } from '../common/sqlConnection.js';
import { ISqlDriverCatalogService } from '../common/sqlDriverCatalog.js';
import { ISqlMetadataService } from '../common/sqlMetadata.js';
import { ISqlQueryService } from '../common/sqlQuery.js';
import { SqlAiService } from './sqlAiService.js';
import { SqlConnectionService } from './sqlConnectionService.js';
import { SqlDriverCatalogService } from './sqlDriverCatalogService.js';
import { SqlMetadataService } from './sqlMetadataService.js';
import { SqlQueryService } from './sqlQueryService.js';

registerSingleton(ISqlConnectionService, SqlConnectionService, InstantiationType.Delayed);
registerSingleton(ISqlMetadataService, SqlMetadataService, InstantiationType.Delayed);
registerSingleton(ISqlQueryService, SqlQueryService, InstantiationType.Delayed);
registerSingleton(ISqlAiService, SqlAiService, InstantiationType.Delayed);
registerSingleton(ISqlDriverCatalogService, SqlDriverCatalogService, InstantiationType.Delayed);
