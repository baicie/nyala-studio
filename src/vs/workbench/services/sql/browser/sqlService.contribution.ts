/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - SQL service registrations.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISqlAiService } from '../common/sqlAi.js';
import { ISqlConnectionService, ISqlConnectionServiceV2 } from '../common/sqlConnection.js';
import { ISqlDriverCatalogService } from '../common/sqlDriverCatalog.js';
import { ISqlMetadataService } from '../common/sqlMetadata.js';
import { ISqlQueryService } from '../common/sqlQuery.js';
import { ISqlProductService } from '../common/sqlProduct.js';
import { SqlAiService } from './sqlAiService.js';
import { SqlConnectionService } from './sqlConnectionService.js';
import { SqlConnectionServiceV2 } from './sqlConnectionServiceV2.js';
import { SqlDriverCatalogService } from './sqlDriverCatalogService.js';
import { SqlMetadataService } from './sqlMetadataService.js';
import { SqlQueryService } from './sqlQueryService.js';
import { SqlProductService } from './sqlProductService.js';

registerSingleton(ISqlConnectionService, SqlConnectionService, InstantiationType.Delayed);
registerSingleton(ISqlConnectionServiceV2, SqlConnectionServiceV2, InstantiationType.Delayed);
registerSingleton(ISqlMetadataService, SqlMetadataService, InstantiationType.Delayed);
registerSingleton(ISqlQueryService, SqlQueryService, InstantiationType.Delayed);
registerSingleton(ISqlAiService, SqlAiService, InstantiationType.Delayed);
registerSingleton(ISqlDriverCatalogService, SqlDriverCatalogService, InstantiationType.Delayed);
registerSingleton(ISqlProductService, SqlProductService, InstantiationType.Delayed);
