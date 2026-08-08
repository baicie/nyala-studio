import { SqlDriverPackage } from '../../../services/sql/common/sqlTypes.js';

export interface SqlDriverPackageStatusBadge {
	readonly text: string;
	readonly title: string;
	readonly className: string;
	readonly installed: boolean;
	readonly canDownload: boolean;
}

export function buildSqlDriverPackageStatusBadge(
	packageEntry: SqlDriverPackage | undefined,
	options: { readonly loaded: boolean; readonly unavailable: boolean }
): SqlDriverPackageStatusBadge {
	if (!options.loaded) {
		return {
			text: 'Loading',
			title: 'Checking the signed driver package cache...',
			className: 'sql-driver-package-badge sql-driver-package-badge--loading',
			installed: false,
			canDownload: false
		};
	}

	if (options.unavailable || !packageEntry) {
		return {
			text: 'Unavailable',
			title: 'Driver package status is unavailable. Refresh to retry.',
			className: 'sql-driver-package-badge sql-driver-package-badge--unavailable',
			installed: false,
			canDownload: false
		};
	}

	if (packageEntry.installed) {
		return {
			text: `Installed ${packageEntry.version}`,
			title: `${packageEntry.displayName} ${packageEntry.version} is cached and verified.`,
			className: 'sql-driver-package-badge sql-driver-package-badge--installed',
			installed: true,
			canDownload: false
		};
	}

	return {
		text: `Download ${packageEntry.version}`,
		title: `${packageEntry.displayName} ${packageEntry.version} is available from the signed manifest.`,
		className: 'sql-driver-package-badge sql-driver-package-badge--available',
		installed: false,
		canDownload: true
	};
}
