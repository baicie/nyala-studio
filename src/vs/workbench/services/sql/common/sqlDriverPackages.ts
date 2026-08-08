import { IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { SqlRuntimeDriverId } from './sqlDriverCatalog.js';
import { SqlDriverPackage } from './sqlTypes.js';

export type { SqlDriverPackage } from './sqlTypes.js';

export const ISqlDriverPackageService = createDecorator<ISqlDriverPackageService>('sqlDriverPackageService');

export interface ISqlDriverPackageService {
	readonly _serviceBrand: undefined;

	getPackages(): Promise<readonly SqlDriverPackage[]>;
	refreshPackages(): Promise<readonly SqlDriverPackage[]>;
	findForDriver(driverId: SqlRuntimeDriverId): SqlDriverPackage | undefined;
	download(packageId: string): Promise<SqlDriverPackage>;
	onChange(listener: () => void): IDisposable;
}
