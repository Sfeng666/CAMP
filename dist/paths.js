import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostPlatform, userHome } from "./platform.js";
export function getCampPaths() {
    const platform = hostPlatform();
    const homeDirectory = userHome();
    const defaults = (() => {
        if (platform === "darwin") {
            const applicationSupport = join(homeDirectory, "Library", "Application Support", "CAMP");
            return {
                home: join(applicationSupport, "data"),
                configDir: join(applicationSupport, "config"),
                stateDir: join(applicationSupport, "state"),
                logDir: join(homeDirectory, "Library", "Logs", "CAMP"),
            };
        }
        if (platform === "windows") {
            const roaming = process.env.APPDATA ?? join(homeDirectory, "AppData", "Roaming");
            const local = process.env.LOCALAPPDATA ?? join(homeDirectory, "AppData", "Local");
            return {
                home: join(local, "CAMP", "data"),
                configDir: join(roaming, "CAMP"),
                stateDir: join(local, "CAMP", "state"),
                logDir: join(local, "CAMP", "logs"),
            };
        }
        const data = process.env.XDG_DATA_HOME ?? join(homeDirectory, ".local", "share");
        const config = process.env.XDG_CONFIG_HOME ?? join(homeDirectory, ".config");
        const state = process.env.XDG_STATE_HOME ?? join(homeDirectory, ".local", "state");
        return {
            home: join(data, "camp"),
            configDir: join(config, "camp"),
            stateDir: join(state, "camp"),
            logDir: join(state, "camp", "logs"),
        };
    })();
    const home = resolve(process.env.CAMP_HOME ?? defaults.home);
    const configDir = resolve(process.env.CAMP_CONFIG_HOME ?? defaults.configDir);
    const stateDir = resolve(process.env.CAMP_STATE_HOME ?? defaults.stateDir);
    return {
        platform,
        home,
        configDir,
        stateDir,
        database: join(home, "camp.sqlite"),
        archiveDir: join(home, "archive"),
        spoolDir: join(home, "spool"),
        backendDir: join(home, "backends"),
        runtimeDir: join(home, "runtime"),
        backupDir: join(home, "backups"),
        logDir: resolve(process.env.CAMP_LOG_HOME ?? defaults.logDir),
        registryExport: join(home, "projects.json"),
        machineConfig: join(configDir, "config.json"),
        modelManifest: join(configDir, "models.json"),
    };
}
export function ensurePrivateDirectory(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    try {
        chmodSync(path, 0o700);
    }
    catch {
        // Best effort on filesystems that do not expose POSIX permissions.
    }
}
export function ensurePrivateFile(path, mode = 0o600) {
    if (!existsSync(path))
        return;
    try {
        chmodSync(path, mode);
    }
    catch {
        // Best effort on filesystems that do not expose POSIX permissions.
    }
}
export function ensureCampDirectories(paths = getCampPaths()) {
    for (const path of [
        paths.home,
        paths.configDir,
        paths.stateDir,
        paths.archiveDir,
        paths.spoolDir,
        paths.backendDir,
        paths.runtimeDir,
        paths.backupDir,
        paths.logDir,
    ]) {
        ensurePrivateDirectory(path);
    }
    return paths;
}
//# sourceMappingURL=paths.js.map