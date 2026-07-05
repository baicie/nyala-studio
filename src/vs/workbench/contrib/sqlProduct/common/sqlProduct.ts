/*---------------------------------------------------------------------------------------------
 * SQL Studio Next - Product constants.
 *--------------------------------------------------------------------------------------------*/

export const SQL_PRODUCT_NAME = 'Nyala Studio';
export const SQL_PRODUCT_STORAGE_PREFIX = 'workbench.sqlStudio.product';

export const SQL_PRODUCT_BOOTSTRAPPED_STORAGE_KEY = `${SQL_PRODUCT_STORAGE_PREFIX}.bootstrapped`;

export const SQL_PRODUCT_HOME_COMMAND_ID = 'sqlStudio.product.home';
export const SQL_PRODUCT_NEW_QUERY_COMMAND_ID = 'sqlStudio.product.newQuery';
export const SQL_PRODUCT_OPEN_RESULTS_COMMAND_ID = 'sqlStudio.product.openResults';
export const SQL_PRODUCT_OPEN_WELCOME_COMMAND_ID = 'sqlStudio.product.openWelcome';

// Re-exported in common so the bootstrap model can build the
// `${viewId}.focus` command id without reaching into `browser/`
// (ViewPane pulls in DOM and CSS that don't belong in `common/`).
// Keep this in sync with the browser-side definition.
export const SQL_PRODUCT_WELCOME_VIEW_ID = 'sqlStudio.product.welcome';

export const SQL_PRODUCT_DEFAULT_QUERY = `-- Nyala Studio
-- Start typing your SQL here.

SELECT 1 AS value;
`;
