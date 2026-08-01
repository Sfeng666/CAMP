import { type HostPlatform } from "./platform.js";
export interface CampPaths {
    platform: HostPlatform;
    home: string;
    configDir: string;
    stateDir: string;
    database: string;
    archiveDir: string;
    spoolDir: string;
    backendDir: string;
    runtimeDir: string;
    backupDir: string;
    logDir: string;
    registryExport: string;
    machineConfig: string;
    modelManifest: string;
}
export declare function getCampPaths(): CampPaths;
export declare function ensurePrivateDirectory(path: string): void;
export declare function ensurePrivateFile(path: string, mode?: number): void;
export declare function ensureCampDirectories(paths?: CampPaths): CampPaths;
