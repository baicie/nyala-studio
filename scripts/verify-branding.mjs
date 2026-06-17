import { readFile } from 'node:fs/promises';

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

function assertStringDoesNotContain(value, forbidden, message) {
	assert(!String(value).toLowerCase().includes(forbidden.toLowerCase()), message);
}

async function readJson(path) {
	return JSON.parse(await readFile(path, 'utf8'));
}

const packageJson = await readJson('package.json');
const tauriConfig = await readJson('src-tauri/tauri.conf.json');
const srcTauriCargo = await readFile('src-tauri/Cargo.toml', 'utf8');

assert(packageJson.name === 'sql-studio-next', `package.json name must be sql-studio-next, got ${packageJson.name}`);

assert(packageJson.version === '0.1.0', `package.json version must be 0.1.0, got ${packageJson.version}`);

assert(packageJson.packageManager?.startsWith('pnpm@'), 'packageManager must use pnpm');

assert(
	tauriConfig.productName === 'SQL Studio Next',
	`tauri productName must be SQL Studio Next, got ${tauriConfig.productName}`
);

assert(
	tauriConfig.identifier === 'com.baicie.sqlstudio',
	`tauri identifier must be com.baicie.sqlstudio, got ${tauriConfig.identifier}`
);

assert(
	tauriConfig.app?.windows?.[0]?.title === 'SQL Studio',
	`main window title must be SQL Studio, got ${tauriConfig.app?.windows?.[0]?.title}`
);

const updaterEndpoints = tauriConfig.plugins?.updater?.endpoints ?? [];

assert(
	updaterEndpoints.length === 0,
	`updater endpoints must be empty in Phase 1, got ${JSON.stringify(updaterEndpoints)}`
);

for (const endpoint of updaterEndpoints) {
	assertStringDoesNotContain(
		endpoint,
		'siden.ai',
		`updater endpoint must not point to upstream Siden infrastructure: ${endpoint}`
	);
}

const tauriConfigText = JSON.stringify(tauriConfig, null, 2);

assertStringDoesNotContain(tauriConfigText, 'SideX', 'tauri.conf.json must not expose SideX branding');

assertStringDoesNotContain(
	tauriConfigText,
	'Siden Technologies',
	'tauri.conf.json must not expose upstream Siden company branding'
);

assertStringDoesNotContain(tauriConfigText, 'cdn.siden.ai', 'tauri.conf.json must not use upstream updater endpoint');

const cargoPackageSection = srcTauriCargo.split('[dependencies]')[0];

assert(
	cargoPackageSection.includes('name = "sql-studio-next"'),
	'src-tauri/Cargo.toml package name must be sql-studio-next'
);

assert(cargoPackageSection.includes('version = "0.1.0"'), 'src-tauri/Cargo.toml package version must be 0.1.0');

assert(
	cargoPackageSection.includes('repository = "https://github.com/baicie/sql-studio-next"'),
	'src-tauri/Cargo.toml repository must point to baicie/sql-studio-next'
);

assert(
	srcTauriCargo.includes('name = "sql-studio-next"'),
	'src-tauri/Cargo.toml bin name must include sql-studio-next'
);

console.log('Branding verification passed.');
