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
const terminalRs = await readFile('src-tauri/src/commands/terminal.rs', 'utf8');
const productRs = await readFile('src-tauri/src/product.rs', 'utf8');
const libRs = await readFile('src-tauri/src/lib.rs', 'utf8');
const updateManagerRs = await readFile('crates/sidex-update/src/manager.rs', 'utf8');
const sidexBridgeTs = await readFile('src/vs/sidex-bridge.ts', 'utf8');
const indexHtml = await readFile('index.html', 'utf8');
const mainTs = await readFile('src/main.ts', 'utf8');
const readme = await readFile('README.md', 'utf8');

assert(packageJson.name === 'sql-studio-next', `package.json name must be sql-studio-next, got ${packageJson.name}`);

assert(packageJson.version === '0.1.0', `package.json version must be 0.1.0, got ${packageJson.version}`);

assert(packageJson.packageManager?.startsWith('pnpm@'), 'packageManager must use pnpm');

assert(
	tauriConfig.productName === 'Nyala Studio',
	`tauri productName must be Nyala Studio, got ${tauriConfig.productName}`
);

assert(
	tauriConfig.identifier === 'com.baicie.sqlstudio',
	`tauri identifier must be com.baicie.sqlstudio, got ${tauriConfig.identifier}`
);

assert(
	tauriConfig.app?.windows?.[0]?.title === 'Nyala',
	`main window title must be Nyala, got ${tauriConfig.app?.windows?.[0]?.title}`
);

assert(
	tauriConfig.bundle?.shortDescription === 'Local-first SQL Workbench.',
	`bundle tagline must be Local-first SQL Workbench, got ${tauriConfig.bundle?.shortDescription}`
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

// ── Runtime branding checks (Problem 1) ──────────────────────────────────────

// Terminal TERM_PROGRAM must not hardcode "SideX"
assertStringDoesNotContain(
	terminalRs,
	'SideX',
	'terminal.rs must not expose SideX branding in TERM_PROGRAM or shell integration comments'
);

// product.rs must define TERMINAL_PROGRAM_NAME
assert(
	productRs.includes('TERMINAL_PROGRAM_NAME'),
	'product.rs must define TERMINAL_PROGRAM_NAME'
);

// product.rs must define the Nyala product identity
assert(
	productRs.includes('PRODUCT_NAME: &str = "Nyala Studio"') && productRs.includes('APP_TITLE: &str = "Nyala"'),
	'product.rs must contain Nyala product branding'
);

// lib.rs app menu must not expose "About SideX"
assertStringDoesNotContain(
	libRs,
	'About SideX',
	'macOS app menu must not expose "About SideX"'
);

// ── Legacy migration constants (Problem 3) ───────────────────────────────────

assert(
	productRs.includes('LEGACY_STORAGE_DB_FILE_NAME'),
	'product.rs must define LEGACY_STORAGE_DB_FILE_NAME for one-shot migration'
);

assert(
	productRs.includes('LEGACY_STATE_DB_FILE_NAME'),
	'product.rs must define LEGACY_STATE_DB_FILE_NAME for one-shot migration'
);

// lib.rs must use resolve_product_data_file for both DB files
assert(
	libRs.includes('resolve_product_data_file'),
	'lib.rs must use resolve_product_data_file for DB file migration'
);

// ── Updater branding check ────────────────────────────────────────────────────

assertStringDoesNotContain(
	updateManagerRs,
	'sidex-update.bin',
	'update manager fallback artifact name must not expose legacy SideX branding'
);

assertStringDoesNotContain(
	sidexBridgeTs,
	'[SideX]',
	'sidex-bridge runtime logs must not expose legacy SideX branding'
);

assertStringDoesNotContain(
	sidexBridgeTs,
	'SideX —',
	'sidex-bridge header must not expose legacy SideX branding'
);

// ── Web entrypoint branding ─────────────────────────────────────────────────

assert(indexHtml.includes('<title>Nyala</title>'), 'index.html title must be Nyala');
assert(indexHtml.includes("nameShort: 'Nyala'"), 'index.html product nameShort must be Nyala');
assert(indexHtml.includes("nameLong: 'Nyala Studio'"), 'index.html product nameLong must be Nyala Studio');
assert(indexHtml.includes("applicationName: 'nyala'"), 'index.html applicationName must be nyala');
assertStringDoesNotContain(indexHtml, '<title>SideX</title>', 'index.html must not expose SideX title');
assertStringDoesNotContain(indexHtml, "nameShort: 'SideX'", 'index.html must not expose SideX product name');
assertStringDoesNotContain(indexHtml, 'marketplace.siden.ai', 'index.html must not use the upstream gallery');

assert(mainTs.includes("nameShort: 'Nyala'"), 'main.ts product nameShort must be Nyala');
assert(mainTs.includes("nameLong: 'Nyala Studio'"), 'main.ts product nameLong must be Nyala Studio');
assert(mainTs.includes('Nyala Studio — Local-first SQL Workbench'), 'main.ts must expose the Nyala tagline');
assertStringDoesNotContain(mainTs, "nameShort: 'SideX'", 'main.ts must not expose SideX product name');
assertStringDoesNotContain(mainTs, 'SideX failed to start', 'startup error must use Nyala branding');

assert(readme.startsWith('# Nyala Studio'), 'README must use the Nyala Studio heading');
assert(readme.includes('Local-first SQL Workbench'), 'README must include the English tagline');
assert(readme.includes('Nyala Studio，本地优先的 SQL 数据库工作台'), 'README must include the Chinese tagline');

console.log('Branding verification passed.');
