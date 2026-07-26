import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export function resolveDemoDataDir({
    environment = process.env,
    platformName = platform(),
    homeDirectory = homedir()
} = {}) {
    const override = environment.NYALA_DATA_DIR;
    if (override) {
        return override;
    }

    if (platformName === 'win32') {
        const appData = environment.APPDATA ?? join(homeDirectory, 'AppData', 'Roaming');
        return join(appData, 'nyala-studio');
    }

    if (platformName === 'darwin') {
        return join(homeDirectory, 'Library', 'Application Support', 'nyala-studio');
    }

    const xdgDataHome = environment.XDG_DATA_HOME ?? join(homeDirectory, '.local', 'share');
    return join(xdgDataHome, 'nyala-studio');
}
